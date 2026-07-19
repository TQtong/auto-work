import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { DomainError } from '@auto-work/contracts';

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface GitCommandResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

@Injectable()
export class GitProcessService {
  public async runRead(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs?: number; outputLimit?: number; allowExitCodes?: readonly number[] } = {},
  ): Promise<GitCommandResult> {
    return this.run(cwd, args, 'read', options);
  }

  /**
   * 写命令仍然只接收参数数组并关闭所有交互凭据提示。调用方只能传入动作白名单生成的参数，
   * 不能把 API 输入直接作为完整命令或参数数组转交到这里。
   */
  public async runWrite(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs?: number; outputLimit?: number; allowExitCodes?: readonly number[] } = {},
  ): Promise<GitCommandResult> {
    return this.run(cwd, args, 'write', options);
  }

  private async run(
    cwd: string,
    args: readonly string[],
    mode: 'read' | 'write',
    options: { timeoutMs?: number; outputLimit?: number; allowExitCodes?: readonly number[] },
  ): Promise<GitCommandResult> {
    this.assertArguments(args);
    return new Promise((resolvePromise, reject) => {
      const startedAt = Date.now();
      const environment = { ...process.env };
      for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_SSH_COMMAND',
        'GIT_ASKPASS',
        'SSH_ASKPASS',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ]) {
        delete environment[key];
      }
      Object.assign(environment, {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_OPTIONAL_LOCKS: mode === 'read' ? '0' : '1',
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C.UTF-8',
      });
      const child = spawn('git.exe', ['--no-pager', ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: environment,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
      let outputBytes = 0;
      let settled = false;
      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        child.kill();
        finishWithError(
          new DomainError(
            mode === 'read' ? 'GIT_READ_TIMEOUT' : 'GIT_WRITE_TIMEOUT',
            mode === 'read' ? 'Git 只读命令超时' : 'Git 写命令超时，结果必须人工复核',
            {
              httpStatus: 503,
              retryable: mode === 'read',
              suggestedAction: mode === 'write' ? 'manual_review' : 'none',
              details: { timeoutMs: options.timeoutMs ?? 5_000 },
            },
          ),
        );
      }, options.timeoutMs ?? 5_000);
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) {
          child.kill();
          finishWithError(
            new DomainError('GIT_OUTPUT_LIMIT', 'Git 输出超过安全上限', {
              httpStatus: 422,
              details: { outputLimit },
            }),
          );
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => finishWithError(error));
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const allowed = options.allowExitCodes ?? [0];
        const stderrText = this.redactOutput(
          Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000),
        );
        if (code === null || !allowed.includes(code)) {
          reject(
            new DomainError(
              mode === 'read' ? 'GIT_READ_FAILED' : 'GIT_WRITE_FAILED',
              mode === 'read' ? 'Git 只读命令执行失败' : 'Git 写命令执行失败',
              {
                httpStatus: 422,
                details: { exitCode: code, stderr: stderrText },
              },
            ),
          );
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdout),
          stderr: stderrText,
          exitCode: code,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  private assertArguments(args: readonly string[]): void {
    if (args.length === 0) throw new DomainError('GIT_ARGUMENTS_EMPTY', 'Git 子命令不能为空');
    for (const argument of args) {
      if (/[\0\r\n]/u.test(argument)) {
        throw new DomainError('GIT_ARGUMENT_INVALID', 'Git 参数包含禁止的控制字符', {
          httpStatus: 422,
        });
      }
    }
  }

  private redactOutput(value: string): string {
    return value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, '$1[REDACTED]@')
      .replace(
        /(?:Bearer|PRIVATE-TOKEN|token|secret|password|oauth2)\s*[:=]?\s*\S+/giu,
        '[REDACTED]',
      );
  }
}
