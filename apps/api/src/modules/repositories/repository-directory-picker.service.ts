import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';

const DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60 * 1_000;
const DIRECTORY_PICKER_OUTPUT_LIMIT_BYTES = 4_096;
const WINDOWS_DIRECTORY_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Auto Work 仓库扫描根目录'
$dialog.ShowNewFolderButton = $true
$initialPath = $env:AUTO_WORK_PICKER_INITIAL_PATH
if ($initialPath -and [System.IO.Directory]::Exists($initialPath)) {
  $dialog.SelectedPath = $initialPath
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write($dialog.SelectedPath)
}
$dialog.Dispose()
`;

export type RepositoryDirectoryPickerMode = 'native' | 'browser_assisted';
export type RepositoryDirectoryPickerExecutor = (initialPath?: string) => Promise<string | null>;

export const REPOSITORY_DIRECTORY_PICKER_EXECUTOR = Symbol('REPOSITORY_DIRECTORY_PICKER_EXECUTOR');
export const REPOSITORY_DIRECTORY_PICKER_PLATFORM = Symbol('REPOSITORY_DIRECTORY_PICKER_PLATFORM');

export function repositoryDirectoryPickerMode(
  deploymentMode: 'native' | 'docker',
  platform: NodeJS.Platform,
): RepositoryDirectoryPickerMode {
  return deploymentMode === 'native' && platform === 'win32' ? 'native' : 'browser_assisted';
}

/**
 * Windows 本机部署通过固定 PowerShell 脚本打开系统文件夹对话框。
 * 初始目录只经专用环境变量传递，绝不拼接到脚本或命令行，避免路径形成命令注入。
 */
export const executeWindowsDirectoryPicker: RepositoryDirectoryPickerExecutor = (initialPath) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        WINDOWS_DIRECTORY_PICKER_SCRIPT,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          WINDIR: process.env.WINDIR ?? 'C:\\Windows',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          USERPROFILE: process.env.USERPROFILE ?? '',
          AUTO_WORK_PICKER_INITIAL_PATH: initialPath ?? '',
        },
      },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(
        new DomainError('DIRECTORY_PICKER_TIMEOUT', '目录选择窗口等待超时', {
          httpStatus: 504,
          details: { timeoutMs: DIRECTORY_PICKER_TIMEOUT_MS },
        }),
      );
    }, DIRECTORY_PICKER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= DIRECTORY_PICKER_OUTPUT_LIMIT_BYTES) stdout.push(chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new DomainError('DIRECTORY_PICKER_START_FAILED', '无法打开 Windows 目录选择窗口', {
          httpStatus: 503,
          details: { processErrorCode: error.code ?? 'unknown' },
        }),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0 || stdoutBytes > DIRECTORY_PICKER_OUTPUT_LIMIT_BYTES) {
        reject(
          new DomainError('DIRECTORY_PICKER_FAILED', 'Windows 目录选择窗口异常结束', {
            httpStatus: 503,
            details: { exitCode: code ?? 'unknown', stdoutBytes },
          }),
        );
        return;
      }
      const selectedPath = Buffer.concat(stdout).toString('utf8').trim();
      resolvePromise(selectedPath || null);
    });
  });

@Injectable()
export class RepositoryDirectoryPickerService {
  private readonly mode: RepositoryDirectoryPickerMode;

  public constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(REPOSITORY_DIRECTORY_PICKER_EXECUTOR)
    private readonly executePicker: RepositoryDirectoryPickerExecutor,
    @Inject(REPOSITORY_DIRECTORY_PICKER_PLATFORM) platform: NodeJS.Platform,
  ) {
    this.mode = repositoryDirectoryPickerMode(config.deploymentMode ?? 'native', platform);
  }

  public get pickerMode(): RepositoryDirectoryPickerMode {
    return this.mode;
  }

  public async select(
    initialPath?: string,
  ): Promise<{ status: 'selected'; path: string } | { status: 'cancelled'; path: null }> {
    if (this.mode !== 'native') {
      throw new DomainError(
        'NATIVE_DIRECTORY_PICKER_UNAVAILABLE',
        '当前部署不能直接打开宿主机目录窗口，请使用浏览器目录选择或手工粘贴路径',
        { httpStatus: 409 },
      );
    }
    const selectedPath = await this.executePicker(initialPath);
    if (!selectedPath) return { status: 'cancelled', path: null };
    if (!isAbsolute(selectedPath) || /[\0\r\n]/u.test(selectedPath)) {
      throw new DomainError('DIRECTORY_PICKER_RESULT_INVALID', '目录选择结果不是有效的绝对路径', {
        httpStatus: 422,
      });
    }
    const canonicalPath = await realpath(selectedPath).catch(() => {
      throw new DomainError(
        'DIRECTORY_PICKER_RESULT_UNAVAILABLE',
        '所选目录不存在或当前进程无权访问',
        {
          httpStatus: 422,
        },
      );
    });
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new DomainError('DIRECTORY_PICKER_RESULT_NOT_DIRECTORY', '所选路径不是目录', {
        httpStatus: 422,
      });
    }
    return { status: 'selected', path: canonicalPath };
  }
}
