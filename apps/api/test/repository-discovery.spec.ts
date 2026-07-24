import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';
import { RepositoryService } from '../src/modules/repositories/repository.service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('仓库发现与状态采集解耦', () => {
  it('身份识别成功后立即登记，不被完整 git status 的耗时阻塞', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-work-discovery-'));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, '大型仓库');
    await mkdir(repositoryPath);
    const collectStatus = vi.fn();
    const inspector = {
      canonicalRoot: vi.fn().mockResolvedValue(root),
      inspect: vi.fn().mockResolvedValue({
        canonicalPath: repositoryPath,
        realPathHash: 'real-path-hash',
        identityHash: 'identity-hash',
        displayName: '大型仓库',
        gitDirKind: 'normal',
        headSha: 'a'.repeat(40),
        branchName: 'main',
        unborn: false,
        defaultRemote: null,
        remotes: [],
      }),
      collectStatus,
    } as unknown as RepositoryInspectorService;
    const created = {
      id: 'repository-1',
      canonicalPath: repositoryPath,
      displayName: '大型仓库',
      alias: null,
      gitDirKind: 'normal',
      remoteName: null,
      remoteUrl: null,
      remoteHost: null,
      remotePort: null,
      remotePath: null,
      gitlabConnectionId: null,
      gitlabProjectRef: null,
      baselineBranch: 'main',
      whitelistStatus: 'discovered',
      statusReason: null,
      lastSeenAt: new Date(),
      lastLocalRefreshAt: null,
      version: 1,
    };
    const prisma = {
      repository: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;

    const result = await new RepositoryService(prisma, inspector).discover(true);

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({
      displayName: '大型仓库',
      whitelistStatus: 'discovered',
      latestSnapshot: null,
    });
    expect(result.warnings).toEqual([]);
    expect(collectStatus).not.toHaveBeenCalled();
  });

  it('重新扫描到曾经缺失的仓库时恢复为待确认状态并清除缺失原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-work-discovery-restored-'));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, '重新出现的仓库');
    await mkdir(repositoryPath);
    const missingRepository = {
      id: 'repository-restored',
      canonicalPath: repositoryPath,
      realPathHash: 'real-path-hash',
      identityHash: 'identity-hash',
      displayName: '重新出现的仓库',
      alias: null,
      gitDirKind: 'normal',
      remoteName: null,
      remoteUrl: null,
      remoteProtocol: null,
      remoteHost: null,
      remotePort: null,
      remotePath: null,
      gitlabConnectionId: null,
      gitlabProjectRef: null,
      baselineBranch: 'main',
      whitelistStatus: 'missing',
      statusReason: '本次一级目录扫描未发现该仓库',
      lastSeenAt: new Date('2026-07-20T00:00:00.000Z'),
      lastLocalRefreshAt: null,
      version: 1,
    };
    const restoredRepository = {
      ...missingRepository,
      whitelistStatus: 'discovered',
      statusReason: null,
      version: 2,
      lastSeenAt: new Date(),
    };
    const inspector = {
      canonicalRoot: vi.fn().mockResolvedValue(root),
      inspect: vi.fn().mockResolvedValue({
        canonicalPath: repositoryPath,
        realPathHash: 'real-path-hash',
        identityHash: 'identity-hash',
        displayName: '重新出现的仓库',
        gitDirKind: 'normal',
        headSha: 'a'.repeat(40),
        branchName: 'main',
        unborn: false,
        defaultRemote: null,
        remotes: [],
      }),
    } as unknown as RepositoryInspectorService;
    const update = vi.fn((input: unknown) => {
      void input;
      return Promise.resolve(restoredRepository);
    });
    const prisma = {
      repository: {
        findUnique: vi.fn().mockResolvedValue(missingRepository),
        update,
        findMany: vi.fn().mockResolvedValue([restoredRepository]),
      },
    } as unknown as PrismaService;

    const result = await new RepositoryService(prisma, inspector).discover(true);

    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'repository-restored' },
      data: {
        whitelistStatus: 'discovered',
        statusReason: null,
        version: { increment: 1 },
      },
    });
    expect(result.repositories[0]).toMatchObject({
      whitelistStatus: 'discovered',
      statusReason: null,
      version: 2,
    });
  });

  it('缺失仓库不能确认，且不会继续访问不存在的路径', async () => {
    const inspect = vi.fn();
    const inspector = { inspect } as unknown as RepositoryInspectorService;
    const prisma = {
      repository: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'repository-missing',
          canonicalPath: 'D:\\repositories\\missing',
          whitelistStatus: 'missing',
        }),
      },
    } as unknown as PrismaService;

    await expect(
      new RepositoryService(prisma, inspector).confirm('repository-missing', {
        displayName: 'missing',
        baselineBranch: 'main',
        discoverySnapshotVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_PATH_UNAVAILABLE' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
