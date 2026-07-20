import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { gitExecutable, GitProcessService } from '../src/infrastructure/git/git-process.service.js';
import { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';

const temporaryDirectories: string[] = [];
let rootDirectory = '';
let repositoryDirectory = '';
let inspector: RepositoryInspectorService;

describe('跨平台 Git 执行文件选择', () => {
  it('Windows 使用 git.exe，Linux 与 macOS 使用 PATH 中的 git', () => {
    expect(gitExecutable('win32')).toBe('git.exe');
    expect(gitExecutable('linux')).toBe('git');
    expect(gitExecutable('darwin')).toBe('git');
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git.exe', args, { cwd, windowsHide: true, stdio: 'ignore' });
}

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), 'auto-work-repositories-'));
  temporaryDirectories.push(rootDirectory);
  repositoryDirectory = join(rootDirectory, '示例 repo');
  await mkdir(repositoryDirectory);
  git(repositoryDirectory, ['init']);
  git(repositoryDirectory, ['config', 'user.name', '自动测试']);
  git(repositoryDirectory, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(repositoryDirectory, '已跟踪.txt'), '第一版\n', 'utf8');
  git(repositoryDirectory, ['add', '--', '已跟踪.txt']);
  git(repositoryDirectory, ['commit', '-m', '初始化']);
  git(repositoryDirectory, [
    'remote',
    'add',
    'origin',
    'https://oauth2:not-a-real-secret@git.example.com/group/repo.git',
  ]);
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3760,
    dataDir: join(rootDirectory, 'data'),
    webDist: join(rootDirectory, 'web'),
    databaseUrl: `file:${join(rootDirectory, 'test.db').replaceAll('\\', '/')}`,
    repositoryRoot: rootDirectory,
    vaultBackend: 'sealed',
    vaultKeyFile: join(rootDirectory, 'data', 'vault-master.key'),
    logLevel: 'info',
    environment: 'test',
  };
  inspector = new RepositoryInspectorService(config, new GitProcessService());
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // 目录由本测试通过 mkdtemp 创建，清理目标严格限定在测试隔离目录。
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe.runIf(process.platform === 'win32')('仓库发现与只读状态', () => {
  it('扫描前返回宿主机路径、容器路径和一级 Git 候选统计', async () => {
    const config = await inspector.discoveryConfiguration();
    expect(config).toMatchObject({
      deploymentMode: 'native',
      configuredRoot: rootDirectory,
      hostRoot: rootDirectory,
      accessible: true,
      status: 'ready',
      scanDepth: 1,
      directoryCount: 1,
      gitCandidateCount: 1,
    });
  });

  it('目录不可用时返回稳定诊断而不是泄漏底层文件系统异常', async () => {
    const unavailable = new RepositoryInspectorService(
      {
        host: '127.0.0.1',
        port: 3760,
        dataDir: join(rootDirectory, 'data'),
        webDist: join(rootDirectory, 'web'),
        databaseUrl: `file:${join(rootDirectory, 'test.db').replaceAll('\\', '/')}`,
        repositoryRoot: join(rootDirectory, '不存在'),
        repositoryHostPath: 'D:/company',
        deploymentMode: 'docker',
        vaultBackend: 'sealed',
        vaultKeyFile: join(rootDirectory, 'data', 'vault-master.key'),
        logLevel: 'info',
        environment: 'test',
      },
      new GitProcessService(),
    );

    await expect(unavailable.discoveryConfiguration()).resolves.toMatchObject({
      deploymentMode: 'docker',
      hostRoot: 'D:/company',
      accessible: false,
      status: 'unavailable',
      directoryCount: 0,
      gitCandidateCount: 0,
    });
  });

  it('识别一级仓库、分支、身份，并在远端入库前丢弃凭证', async () => {
    const identity = await inspector.inspect(repositoryDirectory);
    expect(identity.gitDirKind).toBe('normal');
    expect(identity.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(identity.defaultRemote).toMatchObject({
      name: 'origin',
      protocol: 'https',
      host: 'git.example.com',
      path: 'group/repo',
    });
    expect(JSON.stringify(identity.remotes)).not.toContain('not-a-real-secret');
  });

  it('按 porcelain v2 -z 统计暂存、修改、未跟踪和 Unicode/空格路径', async () => {
    await writeFile(join(repositoryDirectory, '已跟踪.txt'), '第二版\n', 'utf8');
    await writeFile(join(repositoryDirectory, '已暂存 文件.txt'), 'staged\n', 'utf8');
    git(repositoryDirectory, ['add', '--', '已暂存 文件.txt']);
    await writeFile(join(repositoryDirectory, '未跟踪 文件.txt'), 'untracked\n', 'utf8');

    const snapshot = await inspector.collectStatus(repositoryDirectory);
    expect(snapshot.stagedCount).toBe(1);
    expect(snapshot.unstagedCount).toBe(1);
    expect(snapshot.untrackedCount).toBe(1);
    expect(snapshot.conflictedCount).toBe(0);
    expect(snapshot.pathSummary.map((item) => item.path)).toEqual(
      expect.arrayContaining(['已跟踪.txt', '已暂存 文件.txt', '未跟踪 文件.txt']),
    );
  });

  it('拒绝嵌套仓库和包含控制字符的 Git 参数', async () => {
    const nested = join(rootDirectory, 'container', 'nested');
    await mkdir(nested, { recursive: true });
    git(nested, ['init']);
    await expect(inspector.inspect(nested)).rejects.toMatchObject({
      code: 'REPOSITORY_PATH_OUTSIDE_ROOT',
    });
    await expect(
      new GitProcessService().runRead(repositoryDirectory, ['status\n--porcelain']),
    ).rejects.toMatchObject({ code: 'GIT_ARGUMENT_INVALID' });
  });
});
