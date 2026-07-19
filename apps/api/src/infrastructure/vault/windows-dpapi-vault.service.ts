import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import type { CredentialVault } from './credential-vault.js';

const REFERENCE_PATTERN = /^dpapi:([0-9a-f-]{36})$/i;
const DPAPI_OPERATION_TIMEOUT_MS = 30_000;
const ENCRYPT_SCRIPT = `
Add-Type -AssemblyName System.Security
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;
const DECRYPT_SCRIPT = `
Add-Type -AssemblyName System.Security
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$encoded = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encoded)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;

@Injectable()
export class WindowsDpapiVaultService implements CredentialVault {
  private readonly vaultDirectory: string;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.vaultDirectory = join(config.dataDir, 'vault');
  }

  public async put(secret: string): Promise<string> {
    if (!secret) throw new DomainError('CREDENTIAL_EMPTY', '凭证不能为空', { httpStatus: 422 });
    if (process.platform !== 'win32') {
      throw new DomainError('DPAPI_UNAVAILABLE', '凭证保险箱只能在 Windows 当前用户环境中使用', {
        httpStatus: 503,
      });
    }
    await mkdir(this.vaultDirectory, { recursive: true, mode: 0o700 });
    const id = newId();
    const encrypted = await this.runProtectedData(ENCRYPT_SCRIPT, secret);
    await writeFile(join(this.vaultDirectory, `${id}.dpapi`), encrypted, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return `dpapi:${id}`;
  }

  public async get(reference: string): Promise<string> {
    const path = this.resolveReference(reference);
    const encrypted = await readFile(path, 'utf8');
    return this.runProtectedData(DECRYPT_SCRIPT, encrypted);
  }

  public async delete(reference: string): Promise<void> {
    const path = this.resolveReference(reference);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private resolveReference(reference: string): string {
    const match = REFERENCE_PATTERN.exec(reference);
    if (!match?.[1])
      throw new DomainError('CREDENTIAL_REFERENCE_INVALID', '凭证引用格式无效', {
        httpStatus: 422,
      });
    return join(this.vaultDirectory, `${match[1].toLowerCase()}.dpapi`);
  }

  private runProtectedData(script: string, input: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        // Windows 负载较高时 PowerShell 首次启动可能明显变慢；超出预算后必须终止进程，避免永久挂起。
        timedOut = true;
        child.kill();
      }, DPAPI_OPERATION_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        // 启动失败只暴露稳定错误码，不把可能包含本机路径的原始错误返回给 API 调用方。
        reject(
          new DomainError('DPAPI_PROCESS_START_FAILED', 'Windows 凭证保护进程启动失败', {
            httpStatus: 503,
            details: { processErrorCode: error.code ?? 'unknown' },
          }),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new DomainError('DPAPI_OPERATION_TIMEOUT', 'Windows 凭证保护操作超时', {
              httpStatus: 504,
              details: { timeoutMs: DPAPI_OPERATION_TIMEOUT_MS },
            }),
          );
          return;
        }
        if (code === 0) {
          resolvePromise(Buffer.concat(stdout).toString('utf8'));
        } else {
          // stderr 可能包含系统路径，API 只返回稳定错误；详细原因仅留本机受控日志。
          reject(
            new DomainError(
              'DPAPI_OPERATION_FAILED',
              `Windows 凭证保护操作失败（退出码 ${code ?? 'unknown'}）`,
              { httpStatus: 503, details: { stderrLength: Buffer.concat(stderr).length } },
            ),
          );
        }
      });
      child.stdin.end(input, 'utf8');
    });
  }
}
