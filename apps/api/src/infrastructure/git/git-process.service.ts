import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { DomainError } from '@auto-work/contracts';

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface GitCommandResult {
  stdout: Buffer;
  stderr: string;
  durationMs: number;
}

@Injectable()
export class GitProcessService {
  public async runRead(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs?: number; outputLimit?: number; allowExitCodes?: readonly number[] } = {},
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
      ]) {
        delete environment[key];
      }
      Object.assign(environment, {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_OPTIONAL_LOCKS: '0',
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
          new DomainError('GIT_READ_TIMEOUT', 'Git 只读命令超时', {
            httpStatus: 503,
            retryable: true,
            details: { timeoutMs: options.timeoutMs ?? 5_000 },
          }),
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
        const stderrText = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000);
        if (code === null || !allowed.includes(code)) {
          reject(
            new DomainError('GIT_READ_FAILED', 'Git 只读命令执行失败', {
              httpStatus: 422,
              details: { exitCode: code, stderr: stderrText },
            }),
          );
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdout),
          stderr: stderrText,
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
}
