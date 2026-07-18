import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { GitProcessService } from '../src/infrastructure/git/git-process.service.js';
import { GitBatchEngineService } from '../src/modules/git-batches/git-batch-engine.service.js';
import { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';

const temporaryDirectories: string[] = [];
let rootDirectory = '';
let repositoryDirectory = '';
let bareRemoteDirectory = '';
let collaboratorDirectory = '';
let inspector: RepositoryInspectorService;
let engine: GitBatchEngineService;
let repository: Repository;

function git(cwd: string, args: string[], capture = false): string {
  return execFileSync('git.exe', args, {
    cwd,
    windowsHide: true,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  }) as unknown as string;
}

async function commitFile(
  cwd: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(cwd, path), content, 'utf8');
  git(cwd, ['add', '--', path]);
  git(cwd, ['commit', '-m', message]);
}

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), 'auto-work-git-batch-root-'));
  temporaryDirectories.push(rootDirectory);
  const collaborationRoot = await mkdtemp(join(tmpdir(), 'auto-work-git-batch-peer-'));
  temporaryDirectories.push(collaborationRoot);
  repositoryDirectory = join(rootDirectory, '中文 repo');
  bareRemoteDirectory = join(rootDirectory, 'remote.git');
  collaboratorDirectory = join(collaborationRoot, 'peer');
  await mkdir(repositoryDirectory);
  await mkdir(bareRemoteDirectory);
  git(bareRemoteDirectory, ['init', '--bare']);
  git(repositoryDirectory, ['init', '-b', 'main']);
  git(repositoryDirectory, ['config', 'user.name', '自动测试']);
  git(repositoryDirectory, ['config', 'user.email', 'test@example.com']);
  await commitFile(repositoryDirectory, '中文 文件.txt', '初始内容\n', '初始化');
  git(repositoryDirectory, ['remote', 'add', 'origin', bareRemoteDirectory]);
  git(repositoryDirectory, ['push', '--set-upstream', 'origin', 'main']);
  git(bareRemoteDirectory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3760,
    dataDir: join(rootDirectory, 'data'),
    webDist: join(rootDirectory, 'web'),
    databaseUrl: `file:${join(rootDirectory, 'test.db').replaceAll('\\', '/')}`,
    repositoryRoot: rootDirectory,
    logLevel: 'info',
    environment: 'test',
  };
  const gitProcess = new GitProcessService();
  inspector = new RepositoryInspectorService(config, gitProcess);
  engine = new GitBatchEngineService(gitProcess, inspector);
  const identity = await inspector.inspect(repositoryDirectory);
  const now = new Date();
  repository = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    canonicalPath: identity.canonicalPath,
    realPathHash: identity.realPathHash,
    identityHash: identity.identityHash,
    displayName: identity.displayName,
    alias: null,
    gitDirKind: identity.gitDirKind,
    remoteName: 'origin',
    remoteUrl: bareRemoteDirectory,
    remoteProtocol: null,
    remoteHost: null,
    remotePort: null,
    remotePath: null,
    gitlabConnectionId: null,
    gitlabProjectRef: null,
    baselineBranch: 'main',
    whitelistStatus: 'confirmed',
    statusReason: null,
    lastSeenAt: now,
    lastLocalRefreshAt: now,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // 只清理由本测试 mkdtemp 创建并登记的隔离目录，绝不触碰产品仓库根目录。
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe.runIf(process.platform === 'win32')('受限 Git 批次动作引擎', () => {
  it('预览后工作区变化会判定 stale_preview，且不会暂存任何路径', async () => {
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), '准备暂存\n', 'utf8');
    const preview = await engine.preview(repository, 'stage_paths', {
      paths: ['中文 文件.txt'],
    });
    expect(preview.executable).toBe(true);

    await writeFile(join(repositoryDirectory, '后来出现.txt'), '新文件\n', 'utf8');
    const result = await engine.execute(
      repository,
      'stage_paths',
      { paths: ['中文 文件.txt'] },
      preview.snapshotHash,
    );
    expect(result.resultCode).toBe('stale_preview');
    expect(git(repositoryDirectory, ['diff', '--cached', '--name-only'], true).trim()).toBe('');
  }, 30_000);

  it('提交审批绑定 HEAD 与 Index 哈希，新增暂存内容后拒绝创建提交', async () => {
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), '第一项\n', 'utf8');
    git(repositoryDirectory, ['add', '--', '中文 文件.txt']);
    const preview = await engine.preview(repository, 'commit', { message: '受控提交' });
    const headBefore = git(repositoryDirectory, ['rev-parse', 'HEAD'], true).trim();

    await writeFile(join(repositoryDirectory, '额外暂存.txt'), '第二项\n', 'utf8');
    git(repositoryDirectory, ['add', '--', '额外暂存.txt']);
    const result = await engine.execute(
      repository,
      'commit',
      { message: '受控提交' },
      preview.snapshotHash,
    );
    expect(result.resultCode).toBe('stale_preview');
    expect(git(repositoryDirectory, ['rev-parse', 'HEAD'], true).trim()).toBe(headBefore);
  }, 30_000);

  it('远端与本地分叉时同时阻断 pull --ff-only 与普通 push，绝不生成 force 参数', async () => {
    git(rootDirectory, ['clone', bareRemoteDirectory, collaboratorDirectory]);
    git(collaboratorDirectory, ['config', 'user.name', '协作者']);
    git(collaboratorDirectory, ['config', 'user.email', 'peer@example.com']);
    await commitFile(repositoryDirectory, '本地.txt', '本地提交\n', '本地前进');
    await commitFile(collaboratorDirectory, '远端.txt', '远端提交\n', '远端前进');
    git(collaboratorDirectory, ['push', 'origin', 'main']);
    git(repositoryDirectory, ['fetch', 'origin', '--prune']);

    const pull = await engine.preview(repository, 'pull_ff_only', {});
    const push = await engine.preview(repository, 'push', { remote: 'origin', branch: 'main' });
    expect(pull.executable).toBe(false);
    expect(pull.blockingReasons.map((item) => item.code)).toContain('GIT_NON_FAST_FORWARD');
    expect(push.executable).toBe(false);
    expect(push.blockingReasons.map((item) => item.code)).toContain('GIT_PUSH_NOT_FAST_FORWARD');
    expect(push.displayCommand).not.toMatch(/force/iu);
  }, 15_000);

  it('stash apply 冲突进入 needs_review，并保留原 stash 供人工恢复', async () => {
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), 'stash 版本\n', 'utf8');
    git(repositoryDirectory, ['stash', 'push', '-m', '待应用']);
    const stashOid = git(repositoryDirectory, ['rev-parse', 'stash@{0}'], true).trim();
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), '当前分支版本\n', 'utf8');
    git(repositoryDirectory, ['add', '--', '中文 文件.txt']);
    git(repositoryDirectory, ['commit', '-m', '制造冲突']);

    const preview = await engine.preview(repository, 'stash_apply', { stashOid });
    expect(preview.executable).toBe(true);
    const result = await engine.execute(
      repository,
      'stash_apply',
      { stashOid },
      preview.snapshotHash,
    );
    expect(result.resultCode).toBe('needs_review');
    expect((await inspector.collectStatus(repositoryDirectory)).conflictedCount).toBeGreaterThan(0);
    expect(git(repositoryDirectory, ['stash', 'list', '--format=%H'], true)).toContain(stashOid);
  }, 30_000);

  it('创建分支使用预览时解析出的提交，已满足时不重复写入', async () => {
    const preview = await engine.preview(repository, 'create_branch', {
      branch: '功能/中文-branch',
      baseline: 'main',
    });
    expect(preview.executable).toBe(true);
    const result = await engine.execute(
      repository,
      'create_branch',
      { branch: '功能/中文-branch', baseline: 'main' },
      preview.snapshotHash,
    );
    expect(result.resultCode).toBe('succeeded');
    expect(git(repositoryDirectory, ['rev-parse', '功能/中文-branch'], true).trim()).toBe(
      git(repositoryDirectory, ['rev-parse', 'main'], true).trim(),
    );
    expect(git(repositoryDirectory, ['branch', '--show-current'], true).trim()).toBe(
      '功能/中文-branch',
    );
  });

  it('创建并切换分支前阻断脏工作区，预览与执行均不会覆盖修改', async () => {
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), '尚未提交的修改\n', 'utf8');
    const preview = await engine.preview(repository, 'create_branch', {
      branch: '不应创建',
      baseline: 'main',
    });

    expect(preview.executable).toBe(false);
    expect(preview.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GIT_CREATE_BRANCH_WOULD_RISK_CHANGES' }),
      ]),
    );
    expect(() =>
      git(repositoryDirectory, ['show-ref', '--verify', 'refs/heads/不应创建']),
    ).toThrow();
    expect(git(repositoryDirectory, ['branch', '--show-current'], true).trim()).toBe('main');
    expect(await readFile(join(repositoryDirectory, '中文 文件.txt'), 'utf8')).toBe(
      '尚未提交的修改\n',
    );
  });

  it('十个白名单动作均通过固定参数完成正向链路', async () => {
    const run = async (action: string, parameters: Record<string, unknown>) => {
      const preview = await engine.preview(repository, action, parameters);
      expect(preview.executable, JSON.stringify(preview.blockingReasons)).toBe(true);
      const result = await engine.execute(repository, action, parameters, preview.snapshotHash);
      expect(['succeeded', 'already_satisfied']).toContain(result.resultCode);
      return result;
    };

    await run('fetch_prune', { remote: 'origin' });
    await run('create_branch', { branch: 'feature/full-flow', baseline: 'main' });
    await run('checkout', { targetBranch: 'feature/full-flow' });

    await writeFile(join(repositoryDirectory, '中文 文件.txt'), 'stash 内容\n', 'utf8');
    await writeFile(join(repositoryDirectory, '未跟踪 空格.txt'), 'untracked\n', 'utf8');
    await run('stash_create', { message: '完整链路 stash', includeUntracked: true });
    const stashOid = git(repositoryDirectory, ['rev-parse', 'stash@{0}'], true).trim();
    await run('stash_apply', { stashOid });
    await run('stage_paths', { paths: ['中文 文件.txt', '未跟踪 空格.txt'] });
    await run('commit', { message: 'feat: 验证受限动作完整链路' });
    await run('push_set_upstream', { remote: 'origin', branch: 'feature/full-flow' });

    await commitFile(repositoryDirectory, '第二次推送.txt', '普通推送\n', '本地继续前进');
    await run('push', { remote: 'origin', branch: 'feature/full-flow' });

    git(rootDirectory, ['clone', bareRemoteDirectory, collaboratorDirectory]);
    git(collaboratorDirectory, ['config', 'user.name', '协作者']);
    git(collaboratorDirectory, ['config', 'user.email', 'peer@example.com']);
    git(collaboratorDirectory, ['checkout', 'feature/full-flow']);
    await commitFile(collaboratorDirectory, '远端快进.txt', '远端快进\n', '远端快进');
    git(collaboratorDirectory, ['push', 'origin', 'feature/full-flow']);
    git(repositoryDirectory, ['fetch', 'origin', '--prune']);
    await run('pull_ff_only', {});
    expect((await readFile(join(repositoryDirectory, '远端快进.txt'), 'utf8')).trim()).toBe(
      '远端快进',
    );
  }, 60_000);

  it('提交 hook 失败会明确标记 failed，且不会绕过 hook', async () => {
    await writeFile(join(repositoryDirectory, '中文 文件.txt'), '等待提交\n', 'utf8');
    git(repositoryDirectory, ['add', '--', '中文 文件.txt']);
    await writeFile(
      join(repositoryDirectory, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
      'utf8',
    );
    const preview = await engine.preview(repository, 'commit', { message: '不应成功' });
    const headBefore = git(repositoryDirectory, ['rev-parse', 'HEAD'], true).trim();
    const result = await engine.execute(
      repository,
      'commit',
      { message: '不应成功' },
      preview.snapshotHash,
    );
    expect(result.resultCode).toBe('failed');
    expect(git(repositoryDirectory, ['rev-parse', 'HEAD'], true).trim()).toBe(headBefore);
  });

  it('预览后同路径仓库被替换时按身份变化拒绝写入', async () => {
    const preview = await engine.preview(repository, 'create_branch', {
      branch: '不会创建',
      baseline: 'main',
    });
    const originalPath = `${repositoryDirectory}-原身份`;
    await rename(repositoryDirectory, originalPath);
    await mkdir(repositoryDirectory);
    git(repositoryDirectory, ['init', '-b', 'main']);
    git(repositoryDirectory, ['config', 'user.name', '替换者']);
    git(repositoryDirectory, ['config', 'user.email', 'replacement@example.com']);
    await commitFile(repositoryDirectory, '替换.txt', '新身份\n', '替换仓库');

    await expect(
      engine.execute(
        repository,
        'create_branch',
        { branch: '不会创建', baseline: 'main' },
        preview.snapshotHash,
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_IDENTITY_CHANGED' });
    expect(() =>
      git(repositoryDirectory, ['show-ref', '--verify', 'refs/heads/不会创建']),
    ).toThrow();
  });

  it('路径、分支和动作注入在到达 spawn 前即被拒绝', async () => {
    await writeFile(join(repositoryDirectory, '-危险.txt'), '危险\n', 'utf8');
    await expect(
      engine.preview(repository, 'stage_paths', { paths: ['-危险.txt'] }),
    ).rejects.toMatchObject({ code: 'GIT_PATH_INVALID' });
    await expect(
      engine.preview(repository, 'create_branch', { branch: '--force', baseline: 'main' }),
    ).rejects.toMatchObject({ code: 'GIT_REF_INVALID' });
    await expect(engine.preview(repository, 'reset_hard', {})).rejects.toMatchObject({
      code: 'GIT_ACTION_FORBIDDEN',
    });
    expect(await readFile(join(repositoryDirectory, '中文 文件.txt'), 'utf8')).toBe('初始内容\n');
  });
});
