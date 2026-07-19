import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { requestHash } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { EvidenceController } from '../src/modules/evidence/evidence.controller.js';
import { EvidenceLifecycleService } from '../src/modules/evidence/evidence-lifecycle.service.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { TasksController } from '../src/modules/jira/tasks.controller.js';
import { TaskOverrideService } from '../src/modules/jira/task-override.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('证据关系确认、拒绝、撤销与过期', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let lifecycle: EvidenceLifecycleService;
  let idempotency: IdempotencyService;
  let controller: EvidenceController;
  let audit: AuditService;
  const request = {
    autoWork: { correlationId: 'correlation-evidence', sessionId: 'session-evidence' },
  } as FastifyRequest;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-evidence-lifecycle-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'lifecycle.db').replaceAll('\\', '/')}`,
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
    const prismaService = prisma as unknown as PrismaService;
    audit = new AuditService(prismaService);
    lifecycle = new EvidenceLifecycleService(prismaService, audit);
    idempotency = new IdempotencyService(prismaService);
    controller = new EvidenceController(
      lifecycle,
      idempotency,
      { currentProfileId: 'local-user' } as SessionService,
      { sessionHash: () => 'session-hash' } as unknown as LocalSecurityService,
      audit,
    );
  }, 60_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.evidenceLinkEvent.deleteMany();
    await prisma.evidenceLink.deleteMany();
    await prisma.evidence.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    await prisma.project.create({
      data: { id: 'project-1', name: '证据项目', jiraProjectKey: 'PROJ' },
    });
    await prisma.task.create({
      data: {
        id: 'task-1',
        projectId: 'project-1',
        primarySource: 'jira',
        issueKey: 'PROJ-1',
        projectKey: 'PROJ',
        title: '证据生命周期',
        lastObservedAt: new Date('2026-07-17T00:00:00.000Z'),
      },
    });
    await prisma.evidence.createMany({
      data: [
        {
          id: 'evidence-1',
          sourceType: 'commit',
          sourceInternalId: 'commit-1',
          sourceExternalKey: 'abcdef',
          projectId: 'project-1',
          eventAt: new Date('2026-07-17T01:00:00.000Z'),
          title: 'PROJ-1 完成证据生命周期',
          contentHash: 'content-hash-1',
        },
        {
          id: 'evidence-2',
          sourceType: 'release',
          sourceInternalId: 'release-1',
          sourceExternalKey: 'v1.0.0',
          projectId: 'project-1',
          eventAt: new Date('2026-07-18T01:00:00.000Z'),
          title: '首版发布',
          contentHash: 'content-hash-2',
        },
      ],
    });
    await prisma.evidenceLink.create({
      data: {
        id: 'link-1',
        targetType: 'task',
        targetId: 'task-1',
        taskId: 'task-1',
        evidenceId: 'evidence-1',
        method: 'commit_issue_key',
        confidence: 0.98,
        status: 'suggested',
        explanation: 'Commit 命中 issue key',
        matchedValue: 'PROJ-1',
        ruleVersion: 'evidence-rule-v1',
        sourceContentHash: 'content-hash-1',
        events: {
          create: {
            id: 'event-1',
            sequence: 1,
            action: 'suggested',
            toStatus: 'suggested',
            actorType: 'system',
            actorId: 'test-seed',
            sourceContentHash: 'content-hash-1',
            ruleVersion: 'evidence-rule-v1',
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('确认在同一事务完成关系、事件、审计和幂等响应，重复请求只重放', async () => {
    const first = await controller.confirm('link-1', { version: 1 }, 'confirm-key-0001', request);
    expect(first.data).toMatchObject({ status: 'confirmed', version: 2 });
    const replay = await controller.confirm('link-1', { version: 1 }, 'confirm-key-0001', request);
    expect(replay.data).toEqual(first.data);
    const link = await prisma.evidenceLink.findUniqueOrThrow({
      where: { id: 'link-1' },
      include: { events: { orderBy: { sequence: 'asc' } } },
    });
    expect(link.events.map((event) => event.action)).toEqual(['suggested', 'confirmed']);
    expect(await prisma.auditEvent.count({ where: { action: 'evidence.link_confirmed' } })).toBe(1);
    expect(
      await prisma.idempotencyRecord.findFirstOrThrow({
        where: { idempotencyKey: 'confirm-key-0001' },
      }),
    ).toMatchObject({ state: 'completed', httpStatus: 200 });
  });

  it('过期版本返回 412，并把本次幂等记录收敛为失败而不改变关系', async () => {
    await controller.confirm('link-1', { version: 1 }, 'confirm-key-0002', request);
    await expect(
      controller.reject(
        'link-1',
        { version: 1, reason: '使用旧版本拒绝' },
        'reject-stale-0001',
        request,
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_LINK_VERSION_STALE' });
    expect(await prisma.evidenceLink.findUniqueOrThrow({ where: { id: 'link-1' } })).toMatchObject({
      status: 'confirmed',
      version: 2,
    });
    expect(
      await prisma.idempotencyRecord.findFirstOrThrow({
        where: { idempotencyKey: 'reject-stale-0001' },
      }),
    ).toMatchObject({ state: 'failed', errorCode: 'EVIDENCE_LINK_VERSION_STALE' });
    expect(
      await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'evidence.mutation_rejected' },
      }),
    ).toMatchObject({ outcome: 'rejected', errorCode: 'EVIDENCE_LINK_VERSION_STALE' });
  });

  it('拒绝原因持久化且可撤销为建议，全部决定保留事件和审计', async () => {
    const rejected = await controller.reject(
      'link-1',
      { version: 1, reason: '该提交只是基础设施调整' },
      'reject-key-0001',
      request,
    );
    expect(rejected.data).toMatchObject({
      status: 'rejected',
      decisionReason: '该提交只是基础设施调整',
      version: 2,
    });
    const revoked = await controller.revoke(
      'link-1',
      { version: 2, reason: '重新核对后恢复候选' },
      'revoke-key-0001',
      request,
    );
    expect(revoked.data).toMatchObject({ status: 'suggested', version: 3 });
    expect(
      (
        await prisma.evidenceLinkEvent.findMany({
          where: { evidenceLinkId: 'link-1' },
          orderBy: { sequence: 'asc' },
        })
      ).map((event) => event.action),
    ).toEqual(['suggested', 'rejected', 'decision_revoked']);
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it('手工关系直接确认、重复绑定被拒绝，撤销后转为 expired 而不物理删除', async () => {
    const manual = await controller.createManual(
      { taskId: 'task-1', evidenceId: 'evidence-2', explanation: '用户核对发布内容后手工绑定' },
      'manual-key-0001',
      request,
    );
    expect(manual.data).toMatchObject({ method: 'manual', confidence: 1, status: 'confirmed' });
    await expect(
      controller.createManual(
        { taskId: 'task-1', evidenceId: 'evidence-2', explanation: '重复绑定' },
        'manual-key-0002',
        request,
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_LINK_ALREADY_EXISTS' });
    const manualLink = await prisma.evidenceLink.findFirstOrThrow({ where: { method: 'manual' } });
    const revoked = await controller.revoke(
      manualLink.id,
      { version: manualLink.version, reason: '撤销手工判断但保留历史' },
      'manual-revoke-0001',
      request,
    );
    expect(revoked.data).toMatchObject({ method: 'manual', status: 'expired' });
    expect(await prisma.evidenceLink.count({ where: { id: manualLink.id } })).toBe(1);
  });

  it('批量确认只接受同一高确定性规则，关键词或混合方法由服务端拒绝', async () => {
    await prisma.evidenceLink.create({
      data: {
        id: 'link-2',
        targetType: 'task',
        targetId: 'task-1',
        taskId: 'task-1',
        evidenceId: 'evidence-2',
        method: 'keyword',
        confidence: 0.79,
        status: 'suggested',
        explanation: '低置信关键词候选',
        ruleVersion: 'evidence-rule-v1',
        sourceContentHash: 'content-hash-2',
      },
    });
    await expect(
      controller.batchConfirm(
        {
          items: [
            { id: 'link-1', version: 1 },
            { id: 'link-2', version: 1 },
          ],
        },
        'batch-mismatch-0001',
        request,
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_BATCH_RULE_MISMATCH' });
    expect(await prisma.evidenceLink.count({ where: { status: 'confirmed' } })).toBe(0);

    await prisma.evidenceLink.update({
      where: { id: 'link-2' },
      data: { method: 'commit_issue_key', confidence: 0.98 },
    });
    const result = await controller.batchConfirm(
      {
        items: [
          { id: 'link-1', version: 1 },
          { id: 'link-2', version: 1 },
        ],
      },
      'batch-confirm-0001',
      request,
    );
    expect(result.data).toMatchObject({ confirmed: 2, method: 'commit_issue_key' });
    expect(await prisma.evidenceLink.count({ where: { status: 'confirmed' } })).toBe(2);
    expect(
      await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'evidence.links_batch_confirmed' },
      }),
    ).toMatchObject({ outcome: 'succeeded' });
  });

  it('定时过期写系统事件和审计，读模型返回分组计数与来源新鲜度', async () => {
    await prisma.evidenceLink.update({
      where: { id: 'link-1' },
      data: { expiresAt: new Date('2026-07-17T02:00:00.000Z') },
    });
    expect(await lifecycle.expireDueLinks(new Date('2026-07-17T03:00:00.000Z'))).toBe(1);
    const detail = await lifecycle.listTaskEvidence('task-1');
    expect(detail.counts).toEqual({ suggested: 0, confirmed: 0, rejected: 0, expired: 1 });
    expect(detail.items[0]).toMatchObject({
      status: 'expired',
      decisionReason: '关系有效期已结束',
      evidence: { sourceType: 'commit', availabilityState: 'available' },
    });
    const event = await prisma.evidenceLinkEvent.findFirstOrThrow({
      where: { action: 'expired' },
    });
    expect(event).toMatchObject({ actorType: 'system', actorId: 'evidence-expiry-schedule' });
    expect(
      await prisma.auditEvent.findFirstOrThrow({ where: { action: 'evidence.link_expired' } }),
    ).toMatchObject({ actorType: 'system', outcome: 'succeeded' });
    const catalog = await lifecycle.listEvidence({ limit: 1 });
    expect(catalog).toMatchObject({ total: 2, page: { hasMore: true, limit: 1 } });
    await expect(
      lifecycle.listEvidence({ limit: 20, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'PAGINATION_CURSOR_INVALID' });
  });

  it('API 拒绝缺少幂等键、非法额外字段和同 key 不同请求', async () => {
    await expect(
      controller.confirm('link-1', { version: 1 }, undefined, request),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(
      controller.confirm('link-1', { version: 1, unexpected: true }, 'invalid-body-0001', request),
    ).rejects.toBeDefined();
    const started = await idempotency.start({
      actorId: 'local-user',
      route: '/api/v1/evidence-links/link-1/confirm',
      key: 'conflict-key-0001',
      requestHash: requestHash({ id: 'link-1', version: 1 }),
    });
    expect(started.kind).toBe('started');
    await expect(
      controller.confirm('link-1', { version: 2 }, 'conflict-key-0001', request),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('任务列表按证据状态筛选并返回待确认、确认和复核计数', async () => {
    const tasks = new TasksController(prisma as unknown as PrismaService);
    const suggested = await tasks.list({ evidenceState: 'suggested', limit: '20' }, request);
    expect(suggested.data).toEqual([
      expect.objectContaining({
        id: 'task-1',
        evidence: {
          total: 1,
          needsRevalidation: 0,
          state: 'suggested',
          counts: { suggested: 1, confirmed: 0, rejected: 0, expired: 0 },
        },
      }),
    ]);
    expect((await tasks.list({ evidenceState: 'confirmed', limit: '20' }, request)).data).toEqual(
      [],
    );
    await prisma.evidenceLink.update({
      where: { id: 'link-1' },
      data: { status: 'confirmed', revalidationState: 'needs_revalidation' },
    });
    const review = await tasks.list({ evidenceState: 'needs_revalidation', limit: '20' }, request);
    expect(review.data[0]).toMatchObject({
      evidence: { state: 'needs_revalidation', needsRevalidation: 1 },
    });
  });

  it('任务列表组合筛选项目、原始状态、父任务、Sprint、日期和来源且不误命中相似 Sprint', async () => {
    const filterProjectId = '11111111-1111-4111-8111-111111111111';
    await prisma.project.create({
      data: { id: filterProjectId, name: '完整筛选项目', jiraProjectKey: 'FILTER' },
    });
    await prisma.task.createMany({
      data: [
        {
          id: 'task-filter-match',
          projectId: filterProjectId,
          primarySource: 'excel',
          issueKey: 'PROJ-12',
          projectKey: 'PROJ',
          parentIssueKey: 'PROJ-EPIC',
          title: '完整筛选命中任务',
          rawStatusName: '研发处理中',
          normalizedStatus: 'in_progress',
          dueDate: '2026-07-20',
          sprintIdsJson: JSON.stringify(['12', '研发冲刺']),
          lastObservedAt: new Date('2026-07-17T00:00:00.000Z'),
        },
        {
          id: 'task-filter-similar-sprint',
          projectId: filterProjectId,
          primarySource: 'excel',
          issueKey: 'PROJ-112',
          projectKey: 'PROJ',
          parentIssueKey: 'PROJ-EPIC',
          title: '相似 Sprint 不应命中',
          rawStatusName: '研发处理中',
          normalizedStatus: 'in_progress',
          dueDate: '2026-07-20',
          sprintIdsJson: JSON.stringify(['112']),
          lastObservedAt: new Date('2026-07-17T00:00:00.000Z'),
        },
      ],
    });
    const tasks = new TasksController(prisma as unknown as PrismaService);

    const result = await tasks.list(
      {
        projectId: filterProjectId,
        rawStatus: '研发处理中',
        status: 'in_progress',
        parentIssueKey: 'PROJ-EPIC',
        sprintId: '12',
        dateFrom: '2026-07-19',
        dateTo: '2026-07-21',
        source: 'excel',
        currentUser: 'false',
        limit: '20',
      },
      request,
    );

    expect(result.data.map((task) => task.id)).toEqual(['task-filter-match']);
    await expect(
      tasks.list({ sprintId: '12', unexpected: 'forbidden' }, request),
    ).rejects.toBeDefined();
  });

  it('任务覆盖 API 校验字段类型和版本，并在列表、冲突页、撤销与审计中形成闭环', async () => {
    await prisma.task.update({ where: { id: 'task-1' }, data: { dueDate: '2026-07-20' } });
    await prisma.taskFieldProvenance.create({
      data: {
        id: 'task-1-jira-due-date',
        taskId: 'task-1',
        fieldName: 'dueDate',
        sourceType: 'jira',
        decision: 'source_fact',
        valueJson: JSON.stringify('2026-07-20'),
        active: true,
      },
    });
    const overrides = new TaskOverrideService(prisma as unknown as PrismaService, audit);
    const tasks = new TasksController(
      prisma as unknown as PrismaService,
      overrides,
      { currentProfileId: 'local-user' } as SessionService,
      { sessionHash: () => 'session-hash' } as unknown as LocalSecurityService,
    );
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

    await expect(
      tasks.setOverride(
        'task-1',
        {
          fieldName: 'dueDate',
          value: 3_600,
          reason: '字段类型错误',
          expiresAt,
          version: 1,
        },
        request,
      ),
    ).rejects.toBeDefined();
    const setResult = await tasks.setOverride(
      'task-1',
      {
        fieldName: 'dueDate',
        value: '2026-08-01',
        reason: '本地计划经人工确认调整',
        expiresAt,
        version: 1,
      },
      request,
    );
    expect(setResult.data).toMatchObject({
      taskId: 'task-1',
      fieldName: 'dueDate',
      value: '2026-08-01',
      conflictValue: '2026-07-20',
      taskVersion: 2,
    });
    await expect(
      tasks.setOverride(
        'task-1',
        {
          fieldName: 'dueDate',
          value: '2026-08-02',
          reason: '使用旧版本覆盖',
          expiresAt,
          version: 1,
        },
        request,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const list = await tasks.list({ conflict: 'true', limit: '20' }, request);
    expect(list.data[0]).toMatchObject({
      id: 'task-1',
      schedule: { dueDate: '2026-08-01' },
      fieldSources: { dueDate: { sourceType: 'manual', decision: 'override', conflict: true } },
      conflictCount: 1,
    });
    const conflicts = await tasks.conflicts({ limit: '20' }, request);
    expect(conflicts).toMatchObject({
      total: 1,
      data: [
        {
          task: { id: 'task-1' },
          fieldName: 'dueDate',
          manualValue: '2026-08-01',
          jiraValue: '2026-07-20',
        },
      ],
    });

    const revoked = await tasks.revokeOverride(
      'task-1',
      'dueDate',
      { version: 2, reason: '接受 Jira 主事实' },
      request,
    );
    expect(revoked.data).toMatchObject({ value: '2026-07-20', sourceType: 'jira', taskVersion: 3 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 'task-1' } })).dueDate).toBe(
      '2026-07-20',
    );
    expect(
      await prisma.auditEvent.count({
        where: { action: { in: ['task.manual_override_set', 'task.manual_override_revoked'] } },
      }),
    ).toBe(2);
  });
});
