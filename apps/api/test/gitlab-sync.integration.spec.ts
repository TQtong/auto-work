import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { EvidenceMaterializerService } from '../src/modules/evidence/evidence-materializer.service.js';
import type { GitLabApiClient } from '../src/modules/gitlab/gitlab-api.client.js';
import { GitLabReadService } from '../src/modules/gitlab/gitlab-read.service.js';
import { GitLabSyncService } from '../src/modules/gitlab/gitlab-sync.service.js';
import type { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';
import { RepositoryService } from '../src/modules/repositories/repository.service.js';

const sha = '0123456789abcdef0123456789abcdef01234567';
const migrations = [
  '20260717090822_foundation',
  '20260717100716_repository_read_model',
  '20260717102840_gitlab_read_cache',
];

describe('GitLab 多资源缓存集成', () => {
  let tempDirectory: string;
  let prisma: PrismaClient;
  let malformedCommit = false;
  let emptyBranches = false;
  const listQueries: Array<{ path: string; query: Record<string, unknown> }> = [];

  beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'auto-work-gitlab-sync-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(tempDirectory, 'sync.db').replaceAll('\\', '/')}`,
    });
    for (const migration of migrations) {
      const sql = await readFile(resolve('prisma/migrations', migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    await prisma.integrationConnection.create({
      data: {
        id: 'gitlab-connection',
        type: 'gitlab',
        name: '测试 GitLab',
        baseUrl: 'https://git.example.com',
        enabled: true,
        status: 'healthy',
        configJson: JSON.stringify({ projectRefs: ['Group/Project'], historyDays: 120 }),
      },
    });
    await prisma.integrationConnection.create({
      data: {
        id: 'another-gitlab-connection',
        type: 'gitlab',
        name: '另一实例',
        baseUrl: 'https://git.example.com',
        enabled: true,
        status: 'healthy',
        configJson: JSON.stringify({ projectRefs: [] }),
      },
    });
    await prisma.repository.createMany({
      data: [
        {
          id: 'repository-current-connection',
          canonicalPath: 'D:\\qa\\current',
          realPathHash: 'real-current',
          identityHash: 'identity-current',
          displayName: 'current',
          gitDirKind: 'normal',
          remoteHost: 'git.example.com',
          remotePath: 'Group/Project',
          gitlabConnectionId: 'gitlab-connection',
          gitlabProjectRef: '101',
          whitelistStatus: 'confirmed',
        },
        {
          id: 'repository-other-connection',
          canonicalPath: 'D:\\qa\\other',
          realPathHash: 'real-other',
          identityHash: 'identity-other',
          displayName: 'other',
          gitDirKind: 'normal',
          remoteHost: 'git.example.com',
          remotePath: 'Other/Project',
          gitlabConnectionId: 'another-gitlab-connection',
          gitlabProjectRef: '999',
          whitelistStatus: 'confirmed',
        },
      ],
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('持久化全部只读资源，并在畸形响应时保留上一版完整缓存', async () => {
    const resolveProject = vi.fn().mockImplementation((_baseUrl, _token, reference) => {
      const second = reference === 'Second/Project';
      return Promise.resolve({
        id: second ? 102 : 101,
        name: second ? 'Second' : 'Project',
        path_with_namespace: second ? 'Second/Project' : 'Group/Project',
        web_url: second
          ? 'https://git.example.com/Second/Project'
          : 'https://git.example.com/Group/Project',
        default_branch: 'main',
        visibility: 'private',
        archived: false,
        last_activity_at: '2026-07-17T10:00:00+08:00',
      });
    });
    const api = {
      resolveProject,
      projectPath: vi.fn((reference: string | number) => `/projects/${String(reference)}`),
      list: vi.fn(
        (_baseUrl: string, _token: string, path: string, query: Record<string, unknown> = {}) => {
          listQueries.push({ path, query });
          if (path.endsWith('/repository/branches')) {
            if (emptyBranches) return [];
            return [
              {
                name: malformedCommit && path.includes('/101/') ? 'partial-branch' : 'main',
                default: !(malformedCommit && path.includes('/101/')),
                commit: { id: sha },
              },
            ];
          }
          if (path.endsWith('/repository/commits')) {
            return [
              {
                id: malformedCommit && path.includes('/101/') ? 'invalid-sha' : sha,
                title: '完整提交',
                author_name: '测试研发',
                author_email: 'dev@example.com',
                committed_date: '2026-07-17T09:30:00+08:00',
                web_url: `https://git.example.com/Group/Project/-/commit/${sha}`,
              },
            ];
          }
          if (path.endsWith('/merge_requests')) {
            return [
              {
                id: 201,
                iid: 8,
                title: '完整 MR',
                state: 'opened',
                source_branch: 'feature',
                target_branch: 'main',
                updated_at: '2026-07-17T09:40:00+08:00',
                web_url: 'https://git.example.com/Group/Project/-/merge_requests/8',
              },
            ];
          }
          if (path.endsWith('/pipelines')) {
            return [
              {
                id: 301,
                sha,
                ref: 'main',
                status: 'success',
                updated_at: '2026-07-17T09:50:00+08:00',
              },
            ];
          }
          if (path.endsWith('/repository/tags')) {
            return [{ name: 'v1.0.0', target: sha, web_url: 'https://git.example.com/tag/v1.0.0' }];
          }
          if (path.endsWith('/releases')) {
            return [
              {
                tag_name: 'v1.0.0',
                name: '首版',
                _links: { self: 'https://git.example.com/release/v1.0.0' },
              },
            ];
          }
          if (path.endsWith('/members/all')) {
            return [{ id: 401, username: 'tester', name: '测试用户', access_level: 30 }];
          }
          throw new Error(`未覆盖测试路径：${path}`);
        },
      ),
    } as unknown as GitLabApiClient;
    const refreshConnection = vi.fn().mockResolvedValue({ materialized: 0, suggested: 0 });
    const evidenceMaterializer = { refreshConnection } as unknown as EvidenceMaterializerService;
    const service = new GitLabSyncService(
      prisma as unknown as PrismaService,
      api,
      evidenceMaterializer,
    );
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: 'gitlab-connection' },
    });

    const first = await service.sync(
      connection,
      'token-value',
      vi.fn().mockResolvedValue(undefined),
    );
    expect(first.counts).toMatchObject({
      projects: 1,
      branches: 1,
      commits: 1,
      mergeRequests: 1,
      pipelines: 1,
      tags: 1,
      releases: 1,
      members: 1,
    });
    expect(refreshConnection).toHaveBeenCalledTimes(1);
    expect(resolveProject).toHaveBeenCalledWith('https://git.example.com', 'token-value', '101');
    expect(resolveProject).not.toHaveBeenCalledWith(
      'https://git.example.com',
      'token-value',
      '999',
    );
    const project = await prisma.gitLabProject.findFirstOrThrow();
    expect(project).toMatchObject({ syncStatus: 'fresh', syncError: null, stale: false });
    expect(project.syncedAt).toBeInstanceOf(Date);
    const remote = {
      name: 'origin',
      sanitizedUrl: 'https://git.example.com/Group/Project',
      protocol: 'https' as const,
      host: 'git.example.com',
      port: null,
      path: 'Group/Project',
    };
    const repositoryService = new RepositoryService(
      prisma as unknown as PrismaService,
      {
        inspect: vi.fn().mockResolvedValue({
          canonicalPath: 'D:\\qa\\current',
          realPathHash: 'real-current',
          identityHash: 'identity-current',
          displayName: 'current',
          gitDirKind: 'normal',
          headSha: sha,
          branchName: 'main',
          unborn: false,
          defaultRemote: remote,
          remotes: [remote],
        }),
      } as unknown as RepositoryInspectorService,
    );
    await expect(
      repositoryService.confirm('repository-current-connection', {
        displayName: 'current',
        remoteName: 'origin',
        gitlabProjectRef: project.id,
        baselineBranch: 'main',
        discoverySnapshotVersion: 1,
      }),
    ).resolves.toMatchObject({
      gitlabConnectionId: 'gitlab-connection',
      gitlabProjectRef: '101',
      gitlabMatchStatus: 'matched',
    });
    await expect(
      Promise.all([
        prisma.gitLabBranch.count(),
        prisma.gitLabCommit.count(),
        prisma.gitLabMergeRequest.count(),
        prisma.gitLabPipeline.count(),
        prisma.gitLabTag.count(),
        prisma.gitLabRelease.count(),
        prisma.gitLabProjectMember.count(),
      ]),
    ).resolves.toEqual([1, 1, 1, 1, 1, 1, 1]);
    const readService = new GitLabReadService(prisma as unknown as PrismaService);
    await expect(
      readService.list('gitlab-connection', project.id, 'commits', 0, 20),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ sha, title: '完整提交' }],
    });
    await expect(
      readService.list('another-connection', project.id, 'commits', 0, 20),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });

    malformedCommit = true;
    await expect(
      service.sync(
        {
          ...connection,
          configJson: JSON.stringify({
            projectRefs: ['Group/Project', 'Second/Project'],
            historyDays: 120,
          }),
        },
        'token-value',
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow();
    expect(refreshConnection).toHaveBeenCalledTimes(1);
    expect(
      await prisma.gitLabBranch.findUnique({
        where: { gitlabProjectId_name: { gitlabProjectId: project.id, name: 'partial-branch' } },
      }),
    ).toBeNull();
    expect(await prisma.gitLabCommit.count({ where: { gitlabProjectId: project.id } })).toBe(1);
    await expect(
      prisma.gitLabProject.findUniqueOrThrow({ where: { id: project.id } }),
    ).resolves.toMatchObject({
      syncStatus: 'error',
    });
    await expect(
      prisma.gitLabProject.findUniqueOrThrow({
        where: {
          connectionId_externalId: { connectionId: 'gitlab-connection', externalId: '102' },
        },
      }),
    ).resolves.toMatchObject({ syncStatus: 'fresh' });
    expect(
      listQueries.some(
        ({ path, query }) =>
          path.endsWith('/repository/commits') && typeof query.since === 'string',
      ),
    ).toBe(true);

    malformedCommit = false;
    emptyBranches = true;
    await expect(
      service.sync(connection, 'token-value', vi.fn().mockResolvedValue(undefined)),
    ).resolves.toBeDefined();
    expect(refreshConnection).toHaveBeenCalledTimes(2);
    await expect(
      prisma.gitLabBranch.findUniqueOrThrow({
        where: { gitlabProjectId_name: { gitlabProjectId: project.id, name: 'main' } },
      }),
    ).resolves.toMatchObject({ stale: true });

    await expect(
      prisma.repository.update({
        where: { id: 'repository-current-connection' },
        data: {
          gitlabConnectionId: null,
          gitlabProjectRef: null,
          whitelistStatus: 'disabled',
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      service.sync(
        { ...connection, configJson: JSON.stringify({ projectRefs: [], historyDays: 120 }) },
        'token-value',
        vi.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBeDefined();
    await expect(
      prisma.gitLabProject.findUniqueOrThrow({ where: { id: project.id } }),
    ).resolves.toMatchObject({ stale: true });
  }, 30_000);
});
