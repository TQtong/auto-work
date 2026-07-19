import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { EvidenceMaterializerService } from '../src/modules/evidence/evidence-materializer.service.js';

const connectionId = 'gitlab-connection';
const gitlabProjectId = 'gitlab-project';
const localProjectId = 'local-project';
const sha = '0123456789abcdef0123456789abcdef01234567';

describe('GitLab 证据物化与建议抑制', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: EvidenceMaterializerService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-evidence-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'evidence.db').replaceAll('\\', '/')}`,
    });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    service = new EvidenceMaterializerService(prisma as unknown as PrismaService);
    await seed();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('物化六类 GitLab 证据并按确定性规则建立一对多建议', async () => {
    const summary = await service.refreshConnection(connectionId);
    expect(summary).toMatchObject({ materialized: 6, created: 6, suggested: 5 });
    const evidence = await prisma.evidence.findMany({ orderBy: { sourceType: 'asc' } });
    expect(evidence.map((item) => item.sourceType)).toEqual([
      'branch',
      'commit',
      'merge_request',
      'pipeline',
      'release',
      'tag',
    ]);
    expect(evidence.every((item) => item.projectId === localProjectId)).toBe(true);
    const links = await prisma.evidenceLink.findMany({
      include: { evidence: true, events: true },
      orderBy: [{ evidence: { sourceType: 'asc' } }, { targetId: 'asc' }],
    });
    expect(links).toHaveLength(5);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: 'task-100',
          method: 'branch_issue_key',
          confidence: 1,
          status: 'suggested',
        }),
        expect.objectContaining({
          targetId: 'task-200',
          method: 'mr_branch_issue_key',
          confidence: 0.95,
        }),
      ]),
    );
    expect(links.every((link) => link.events.length === 1)).toBe(true);
    expect(links.every((link) => link.events[0]?.action === 'suggested')).toBe(true);
  });

  it('相同内容与规则下抑制已拒绝建议，来源变化后才重新建议', async () => {
    const branchEvidence = await prisma.evidence.findFirstOrThrow({
      where: { sourceType: 'branch' },
    });
    const link = await prisma.evidenceLink.findUniqueOrThrow({
      where: {
        targetType_targetId_evidenceId: {
          targetType: 'task',
          targetId: 'task-100',
          evidenceId: branchEvidence.id,
        },
      },
    });
    await prisma.evidenceLink.update({
      where: { id: link.id },
      data: {
        status: 'rejected',
        rejectedBy: 'local-user',
        rejectedAt: new Date(),
        decisionReason: '与任务无关',
        version: { increment: 1 },
      },
    });
    const suppressed = await service.refreshConnection(connectionId);
    expect(suppressed.suppressed).toBeGreaterThanOrEqual(1);
    expect((await prisma.evidenceLink.findUniqueOrThrow({ where: { id: link.id } })).status).toBe(
      'rejected',
    );

    await prisma.gitLabBranch.update({
      where: { id: 'branch-1' },
      data: { name: 'feature/PROJ-100-PROJ-200-v2', sha: sha.replace(/^0/u, '1') },
    });
    const changed = await service.refreshConnection(connectionId);
    expect(changed.resuggested).toBeGreaterThanOrEqual(1);
    const resuggested = await prisma.evidenceLink.findUniqueOrThrow({
      where: { id: link.id },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(resuggested).toMatchObject({
      status: 'suggested',
      rejectedBy: null,
      rejectedAt: null,
      decisionReason: null,
    });
    expect(resuggested.events.map((event) => event.action)).toContain('resuggested');
  });

  it('Pipeline 仅从已确认同 SHA Commit 继承，并保留来源变化后的复核状态', async () => {
    const commitEvidence = await prisma.evidence.findFirstOrThrow({
      where: { sourceType: 'commit' },
    });
    const commitLink = await prisma.evidenceLink.findUniqueOrThrow({
      where: {
        targetType_targetId_evidenceId: {
          targetType: 'task',
          targetId: 'task-100',
          evidenceId: commitEvidence.id,
        },
      },
    });
    await prisma.evidenceLink.update({
      where: { id: commitLink.id },
      data: { status: 'confirmed', confirmedBy: 'local-user', confirmedAt: new Date() },
    });
    await service.refreshConnection(connectionId);
    const pipelineEvidence = await prisma.evidence.findFirstOrThrow({
      where: { sourceType: 'pipeline' },
    });
    const pipelineLink = await prisma.evidenceLink.findUniqueOrThrow({
      where: {
        targetType_targetId_evidenceId: {
          targetType: 'task',
          targetId: 'task-100',
          evidenceId: pipelineEvidence.id,
        },
      },
    });
    expect(pipelineLink).toMatchObject({
      method: 'pipeline_confirmed_commit',
      confidence: 0.95,
      status: 'suggested',
    });

    const branchEvidence = await prisma.evidence.findFirstOrThrow({
      where: { sourceType: 'branch' },
    });
    const confirmedBranchLink = await prisma.evidenceLink.findUniqueOrThrow({
      where: {
        targetType_targetId_evidenceId: {
          targetType: 'task',
          targetId: 'task-200',
          evidenceId: branchEvidence.id,
        },
      },
    });
    await prisma.evidenceLink.update({
      where: { id: confirmedBranchLink.id },
      data: { status: 'confirmed', confirmedBy: 'local-user', confirmedAt: new Date() },
    });
    await prisma.gitLabBranch.update({
      where: { id: 'branch-1' },
      data: { sha: sha.replace(/^0/u, '2') },
    });
    await service.refreshConnection(connectionId);
    expect(
      await prisma.evidenceLink.findUniqueOrThrow({ where: { id: confirmedBranchLink.id } }),
    ).toMatchObject({ status: 'confirmed', revalidationState: 'needs_revalidation' });
  });

  it('来源不可用时过期未确认建议但不删除已确认关系', async () => {
    await prisma.gitLabBranch.update({ where: { id: 'branch-1' }, data: { stale: true } });
    const summary = await service.refreshConnection(connectionId);
    expect(summary.expired).toBeGreaterThanOrEqual(1);
    const branchEvidence = await prisma.evidence.findFirstOrThrow({
      where: { sourceType: 'branch' },
      include: { links: true },
    });
    expect(branchEvidence.availabilityState).toBe('unavailable');
    expect(branchEvidence.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: 'task-100', status: 'expired' }),
        expect.objectContaining({
          targetId: 'task-200',
          status: 'confirmed',
          revalidationState: 'needs_revalidation',
        }),
      ]),
    );
  });

  it('SQLite 约束拒绝越界置信度和不一致的 task target', async () => {
    const evidence = await prisma.evidence.findFirstOrThrow();
    await expect(
      prisma.evidenceLink.create({
        data: {
          id: 'invalid-confidence',
          targetType: 'task',
          targetId: 'task-100',
          taskId: 'task-100',
          evidenceId: evidence.id,
          method: 'keyword',
          confidence: 1.01,
          explanation: '非法置信度',
          ruleVersion: 'evidence-rule-v1',
          sourceContentHash: evidence.contentHash,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.evidenceLink.create({
        data: {
          id: 'invalid-target',
          targetType: 'task',
          targetId: 'task-200',
          taskId: 'task-100',
          evidenceId: evidence.id,
          method: 'keyword',
          confidence: 0.5,
          explanation: '目标不一致',
          ruleVersion: 'evidence-rule-v1',
          sourceContentHash: evidence.contentHash,
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });

  async function seed() {
    await prisma.integrationConnection.create({
      data: {
        id: connectionId,
        type: 'gitlab',
        name: '证据测试 GitLab',
        baseUrl: 'https://git.example.com',
      },
    });
    await prisma.project.create({
      data: { id: localProjectId, name: '研发工作台', jiraProjectKey: 'PROJ' },
    });
    await prisma.repository.create({
      data: {
        id: 'repository-1',
        projectId: localProjectId,
        canonicalPath: 'D:\\company\\evidence',
        realPathHash: 'real-path',
        identityHash: 'identity',
        displayName: 'evidence',
        gitDirKind: 'normal',
        gitlabConnectionId: connectionId,
        gitlabProjectRef: '101',
        whitelistStatus: 'confirmed',
      },
    });
    await prisma.gitLabProject.create({
      data: {
        id: gitlabProjectId,
        connectionId,
        externalId: '101',
        pathWithNamespace: 'team/evidence',
        name: 'evidence',
        webUrl: 'https://git.example.com/team/evidence',
        visibility: 'private',
        lastSeenRunId: 'run-1',
        syncStatus: 'fresh',
        syncedAt: new Date('2026-07-18T01:00:00.000Z'),
      },
    });
    await prisma.task.createMany({
      data: [
        {
          id: 'task-100',
          projectId: localProjectId,
          primarySource: 'jira',
          issueKey: 'PROJ-100',
          projectKey: 'PROJ',
          title: '实现 Excel 导入向导',
          lastObservedAt: new Date('2026-07-17T00:00:00.000Z'),
        },
        {
          id: 'task-200',
          projectId: localProjectId,
          primarySource: 'jira',
          issueKey: 'PROJ-200',
          projectKey: 'PROJ',
          title: '证据生命周期',
          lastObservedAt: new Date('2026-07-17T00:00:00.000Z'),
        },
      ],
    });
    const syncedAt = new Date('2026-07-18T01:00:00.000Z');
    await prisma.gitLabBranch.create({
      data: {
        id: 'branch-1',
        gitlabProjectId,
        name: 'feature/PROJ-100-PROJ-200',
        sha,
        webUrl: 'https://git.example.com/team/evidence/-/tree/feature',
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
    await prisma.gitLabCommit.create({
      data: {
        id: 'commit-1',
        gitlabProjectId,
        sha,
        title: 'feat: PROJ-100 完成导入向导',
        messageSummary: '补齐安全预检',
        authorName: '当前用户',
        authorEmail: 'user@example.com',
        committedAt: new Date('2026-07-17T08:00:00.000Z'),
        webUrl: `https://git.example.com/team/evidence/-/commit/${sha}`,
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
    await prisma.gitLabMergeRequest.create({
      data: {
        id: 'mr-1',
        gitlabProjectId,
        externalId: '201',
        iid: 12,
        title: 'PROJ-100 导入向导验收',
        state: 'merged',
        sourceBranch: 'feature/PROJ-200-evidence',
        targetBranch: 'main',
        updatedExternalAt: new Date('2026-07-18T00:00:00.000Z'),
        webUrl: 'https://git.example.com/team/evidence/-/merge_requests/12',
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
    await prisma.gitLabPipeline.create({
      data: {
        id: 'pipeline-1',
        gitlabProjectId,
        externalId: '301',
        iid: 88,
        sha,
        ref: 'feature/PROJ-100',
        status: 'success',
        webUrl: 'https://git.example.com/team/evidence/-/pipelines/301',
        updatedExternalAt: new Date('2026-07-18T00:30:00.000Z'),
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
    await prisma.gitLabTag.create({
      data: {
        id: 'tag-1',
        gitlabProjectId,
        name: 'v1.0.0',
        targetSha: sha,
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
    await prisma.gitLabRelease.create({
      data: {
        id: 'release-1',
        gitlabProjectId,
        tagName: 'v1.0.0',
        name: '证据工作台首版',
        releasedAt: new Date('2026-07-18T01:00:00.000Z'),
        lastSeenRunId: 'run-1',
        syncedAt,
      },
    });
  }
});
