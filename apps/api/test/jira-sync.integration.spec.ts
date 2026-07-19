import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { JiraApiClient } from '../src/modules/jira/jira-api.client.js';
import { JiraMappingService } from '../src/modules/jira/jira-mapping.service.js';
import { JiraSyncService } from '../src/modules/jira/jira-sync.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { TaskOverrideService } from '../src/modules/jira/task-override.service.js';

const fieldMappings = {
  plannedStartDate: 'customfield_start',
  dueDate: 'duedate',
  sprint: 'customfield_sprint',
  parent: 'parent',
  originalEstimateSeconds: 'timeoriginalestimate',
  remainingEstimateSeconds: 'timeestimate',
  timeSpentSeconds: 'timespent',
  assignee: 'assignee',
  status: 'status',
  priority: 'priority',
  labels: 'labels',
  components: 'components',
};

function issue(key: string, updated: string, overrides: Record<string, unknown> = {}) {
  return {
    id: key.replace(/\D/gu, ''),
    key,
    fields: {
      summary: `任务 ${key}`,
      updated,
      project: { key: 'PROJ' },
      issuetype: { name: '任务' },
      status: { id: '3', name: '进行中' },
      assignee: { accountId: 'current-user', displayName: '当前用户' },
      priority: { name: 'Medium' },
      parent: null,
      customfield_start: null,
      duedate: null,
      timeoriginalestimate: null,
      timeestimate: null,
      timespent: null,
      customfield_sprint: [],
      labels: [],
      components: [],
      ...overrides,
    },
  };
}

describe('Jira 防漏增量同步', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  const connectionId = '10000000-0000-4000-8000-000000000001';
  const mappingId = '10000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-jira-sync-'));
    await mkdir(join(temporaryDirectory, 'data'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'jira.db').replaceAll('\\', '/')}`,
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
    const foreignKeyViolations = await prisma.$queryRawUnsafe<unknown[]>(
      'PRAGMA foreign_key_check',
    );
    if (foreignKeyViolations.length > 0) throw new Error('生产迁移存在外键完整性错误');
    await prisma.userProfile.create({
      data: { id: 'local-user', windowsSid: 'S-1-5-21-test', displayName: '当前用户' },
    });
    await prisma.project.create({
      data: { id: newId(), name: '项目', jiraProjectKey: 'PROJ' },
    });
    await prisma.integrationConnection.create({
      data: {
        id: connectionId,
        type: 'jira',
        name: '契约 Jira',
        baseUrl: 'https://jira.example.com',
        enabled: true,
        status: 'healthy',
        configJson: JSON.stringify({ authScheme: 'bearer', maxResults: 2 }),
        capabilitiesJson: JSON.stringify({
          authenticated: true,
          search: { selectedMethod: 'post' },
          identity: { id: 'current-user', name: '当前用户' },
        }),
      },
    });
    await prisma.fieldMappingVersion.create({
      data: {
        id: mappingId,
        connectionId,
        versionNo: 1,
        fieldMappingsJson: JSON.stringify(fieldMappings),
        statusMappingsJson: JSON.stringify({ '3': 'in_progress', '5': 'done' }),
        parserRulesJson: JSON.stringify({ parentFallbackFieldId: null }),
        validationSummaryJson: '{}',
        createdBy: 'local-user',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function createRun(scope: 'incremental' | 'full' = 'incremental') {
    const request = { scope };
    return prisma.jiraSyncRun.create({
      data: {
        id: newId(),
        connectionId,
        scope,
        trigger: 'test',
        status: 'queued',
        mappingVersionId: mappingId,
        queryHash: requestHash(request),
        requestJson: JSON.stringify(request),
        startedAt: new Date(),
      },
    });
  }

  function serviceWithPages(
    implementation: (
      startAt: number,
      call: number,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ) {
    let call = 0;
    const searchPage = vi.fn(async (input: { startAt: number }) => {
      const result = await implementation(input.startAt, call);
      call += 1;
      return result;
    });
    const service = new JiraSyncService(
      prisma as unknown as PrismaService,
      { searchPage } as unknown as JiraApiClient,
    );
    return { service, searchPage };
  }

  async function execute(service: JiraSyncService, runId: string) {
    const [run, connection] = await Promise.all([
      prisma.jiraSyncRun.findUniqueOrThrow({ where: { id: runId } }),
      prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }),
    ]);
    return service.sync({
      run,
      connection,
      token: 'fixture-token',
      reportProgress: () => Promise.resolve(),
    });
  }

  it('同一 updated 跨页、total 变化和服务端缩页时全部入库并推进复合水位', async () => {
    const updated = '2026-07-17T10:00:00.000Z';
    const pages = new Map<number, Record<string, unknown>>([
      [
        0,
        {
          startAt: 0,
          maxResults: 2,
          total: 4,
          issues: [issue('PROJ-1', updated), issue('PROJ-2', updated)],
        },
      ],
      [2, { startAt: 2, maxResults: 1, total: 6, issues: [issue('PROJ-3', updated)] }],
      [
        3,
        {
          startAt: 3,
          maxResults: 2,
          total: 6,
          issues: [issue('PROJ-4', updated), issue('PROJ-5', updated)],
        },
      ],
      [
        5,
        {
          startAt: 5,
          maxResults: 1,
          total: 6,
          issues: [issue('PROJ-6', updated, { status: { id: '99', name: '未知状态' } })],
        },
      ],
    ]);
    const { service, searchPage } = serviceWithPages((startAt) => pages.get(startAt)!);
    const run = await createRun();
    const result = await execute(service, run.id);

    expect(result.counts).toMatchObject({ pages: 4, read: 6, created: 6 });
    expect(searchPage.mock.calls.map((call) => call[0].startAt)).toEqual([0, 2, 3, 5]);
    expect(await prisma.task.count({ where: { connectionId } })).toBe(6);
    expect(await prisma.taskSourceObservation.count()).toBe(6);
    expect(await prisma.taskStatusEvent.count()).toBe(6);
    const unknown = await prisma.task.findUniqueOrThrow({
      where: { connectionId_issueKey: { connectionId, issueKey: 'PROJ-6' } },
    });
    expect(unknown).toMatchObject({
      rawStatusId: '99',
      rawStatusName: '未知状态',
      normalizedStatus: 'other',
    });
    const cursor = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_scope: { connectionId, scope: 'jira:incremental' } },
    });
    expect(cursor.lastUpdatedAt?.toISOString()).toBe(updated);
    expect(cursor.lastTiebreaker).toBe('PROJ-6');
  });

  it('人工覆盖保留有效期、Jira 新事实形成显式冲突，撤销和到期恢复最新 Jira 值', async () => {
    const firstUpdated = '2026-07-17T15:00:00.000Z';
    const firstRun = await createRun();
    const firstSync = serviceWithPages((startAt) => ({
      startAt,
      total: 1,
      issues: startAt === 0 ? [issue('PROJ-900', firstUpdated, { duedate: '2026-07-20' })] : [],
    })).service;
    await execute(firstSync, firstRun.id);
    const initial = await prisma.task.findUniqueOrThrow({
      where: { connectionId_issueKey: { connectionId, issueKey: 'PROJ-900' } },
    });
    const overrides = new TaskOverrideService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
    const auditContext = {
      actorId: 'local-user',
      correlationId: 'override-integration',
      clientSessionHash: 'session-hash',
    };
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await overrides.setOverride(
      initial.id,
      {
        fieldName: 'dueDate',
        value: '2026-08-01',
        reason: '本地排期经负责人确认延后',
        expiresAt,
        version: initial.version,
      },
      auditContext,
    );

    const secondRun = await createRun();
    const secondSync = serviceWithPages((startAt) => ({
      startAt,
      total: 1,
      issues:
        startAt === 0
          ? [issue('PROJ-900', '2026-07-17T16:00:00.000Z', { duedate: '2026-07-25' })]
          : [],
    })).service;
    await execute(secondSync, secondRun.id);

    const conflictedTask = await prisma.task.findUniqueOrThrow({ where: { id: initial.id } });
    expect(conflictedTask.dueDate).toBe('2026-08-01');
    const conflict = await prisma.taskFieldProvenance.findFirstOrThrow({
      where: { taskId: initial.id, fieldName: 'dueDate', sourceType: 'manual', active: true },
    });
    expect(JSON.parse(conflict.conflictValueJson!)).toBe('2026-07-25');
    expect(conflict.conflictDetectedAt).toBeInstanceOf(Date);
    await expect(overrides.listConflicts({ limit: 20 })).resolves.toMatchObject({
      total: 1,
      items: [
        {
          task: { id: initial.id, issueKey: 'PROJ-900' },
          fieldName: 'dueDate',
          manualValue: '2026-08-01',
          jiraValue: '2026-07-25',
        },
      ],
    });

    const revoked = await overrides.revokeOverride(
      initial.id,
      'dueDate',
      { version: conflictedTask.version, reason: '接受 Jira 最新排期' },
      auditContext,
    );
    expect(revoked).toMatchObject({ value: '2026-07-25', sourceType: 'jira' });
    const afterRevoke = await prisma.task.findUniqueOrThrow({ where: { id: initial.id } });
    expect(afterRevoke.dueDate).toBe('2026-07-25');

    await overrides.setOverride(
      initial.id,
      {
        fieldName: 'dueDate',
        value: '2026-08-05',
        reason: '短期本地计划试算',
        expiresAt,
        version: afterRevoke.version,
      },
      auditContext,
    );
    expect(await overrides.expireDue(new Date(expiresAt.getTime() + 1))).toBe(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: initial.id } })).dueDate).toBe(
      '2026-07-25',
    );
    expect(
      await prisma.auditEvent.count({
        where: {
          action: {
            in: [
              'task.manual_override_set',
              'task.manual_override_revoked',
              'task.manual_override_expired',
            ],
          },
        },
      }),
    ).toBe(4);

    // 本文件后续场景共享数据库；精确移除本场景事实，避免容量断言被测试自身污染。
    await prisma.taskFieldProvenance.deleteMany({ where: { taskId: initial.id } });
    await prisma.taskStatusEvent.deleteMany({ where: { taskId: initial.id } });
    await prisma.taskSourceObservation.deleteMany({ where: { taskId: initial.id } });
    await prisma.task.delete({ where: { id: initial.id } });
    await prisma.auditEvent.deleteMany({
      where: {
        targetId: initial.id,
        action: { startsWith: 'task.manual_override_' },
      },
    });
  });

  it('字段和状态映射通过样例能力校验后创建不可变新版本', async () => {
    const fields = Object.entries(fieldMappings).flatMap(([purpose, id]) =>
      id
        ? [
            {
              id,
              name: purpose,
              schema: {
                type:
                  purpose.includes('Date') || id === 'duedate'
                    ? 'date'
                    : id.includes('time')
                      ? 'number'
                      : id === 'status'
                        ? 'status'
                        : id === 'assignee'
                          ? 'user'
                          : ['labels', 'components', 'customfield_sprint'].includes(id)
                            ? 'array'
                            : 'any',
              },
              occurrenceRate: 1,
              sampleValues: [],
            },
          ]
        : [],
    );
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: {
        capabilitiesJson: JSON.stringify({
          authenticated: true,
          search: { selectedMethod: 'post' },
          identity: { id: 'current-user', name: '当前用户' },
          fields,
          statuses: [
            { id: '3', name: '进行中' },
            { id: '5', name: '完成' },
          ],
        }),
      },
    });
    const recordAudit = vi.fn();
    const audit = { record: recordAudit } as unknown as AuditService;
    const mappingService = new JiraMappingService(
      prisma as unknown as PrismaService,
      audit,
      { currentProfileId: 'local-user' } as unknown as SessionService,
      { sessionHash: () => 'session-hash' } as unknown as LocalSecurityService,
    );
    const created = await mappingService.create(
      connectionId,
      {
        fieldMappings,
        statusMappings: { '3': 'in_progress', '5': 'done' },
        parserRules: {
          parentFallbackFieldId: null,
          sprintStringFallback: true,
          preserveUnknownStatus: true,
        },
      },
      { correlationId: 'correlation', sessionId: 'session' },
    );
    expect(created.versionNo).toBe(2);
    expect(await prisma.fieldMappingVersion.count({ where: { connectionId } })).toBe(2);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'jira.mapping_created', targetId: created.id }),
    );
  });

  it('重叠窗口重复返回旧任务时内容哈希幂等，只为真实变化追加观测和状态区间', async () => {
    const updated = '2026-07-17T10:00:00.000Z';
    const changedAt = '2026-07-17T10:05:00.000Z';
    const { service } = serviceWithPages((startAt) =>
      startAt === 0
        ? {
            startAt: 0,
            total: 2,
            issues: [
              issue('PROJ-1', updated),
              issue('PROJ-2', changedAt, { status: { id: '5', name: '完成' } }),
            ],
          }
        : { startAt, total: 2, issues: [] },
    );
    const run = await createRun();
    const result = await execute(service, run.id);

    expect(result.counts).toMatchObject({ read: 2, unchanged: 1, updated: 1 });
    expect(await prisma.taskSourceObservation.count()).toBe(7);
    expect(await prisma.taskStatusEvent.count()).toBe(7);
    const changed = await prisma.task.findUniqueOrThrow({
      where: { connectionId_issueKey: { connectionId, issueKey: 'PROJ-2' } },
    });
    expect(changed.normalizedStatus).toBe('done');
    const event = await prisma.taskStatusEvent.findFirstOrThrow({
      where: { taskId: changed.id, toNormalizedStatus: 'done' },
    });
    expect(event.observedIntervalStart).not.toBeNull();
  });

  it('中间空页和字段类型漂移均失败且不推进最后成功水位', async () => {
    const cursorBefore = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_scope: { connectionId, scope: 'jira:incremental' } },
    });
    const { service: emptyPageService } = serviceWithPages(() => ({
      startAt: 0,
      total: 10,
      issues: [],
    }));
    const emptyRun = await createRun();
    await expect(execute(emptyPageService, emptyRun.id)).rejects.toMatchObject({
      code: 'JIRA_PAGINATION_EMPTY_PAGE',
    });
    const cursorAfterEmpty = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_scope: { connectionId, scope: 'jira:incremental' } },
    });
    expect(cursorAfterEmpty.lastSuccessRunId).toBe(cursorBefore.lastSuccessRunId);

    const { service: driftService } = serviceWithPages(() => ({
      startAt: 0,
      total: 1,
      issues: [issue('PROJ-7', '2026-07-17T11:00:00.000Z', { timeoriginalestimate: '八小时' })],
    }));
    const driftRun = await createRun();
    await expect(execute(driftService, driftRun.id)).rejects.toMatchObject({
      code: 'JIRA_MAPPING_INVALID',
    });
    expect(
      (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } }))
        .status,
    ).toBe('mapping_invalid');
    expect(
      (await prisma.jiraSyncRun.findUniqueOrThrow({ where: { id: driftRun.id } })).status,
    ).toBe('failed');
  });

  it('只有完整全量核对成功后才把未见任务标为 out_of_scope', async () => {
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { status: 'healthy' },
    });
    const { service } = serviceWithPages(() => ({
      startAt: 0,
      total: 1,
      issues: [issue('PROJ-1', '2026-07-17T12:00:00.000Z')],
    }));
    const run = await createRun('full');
    await execute(service, run.id);
    expect(await prisma.task.count({ where: { connectionId, visibilityState: 'visible' } })).toBe(
      1,
    );
    expect(
      await prisma.task.count({ where: { connectionId, visibilityState: 'out_of_scope' } }),
    ).toBe(5);
  });

  it('第三页超时保留已写幂等观测但不推进成功水位，安全重放可收敛', async () => {
    const cursorBefore = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_scope: { connectionId, scope: 'jira:incremental' } },
    });
    const { service } = serviceWithPages((startAt) => {
      if (startAt >= 4) {
        throw new DomainError('EXTERNAL_REQUEST_TIMEOUT', '第三页超时', {
          httpStatus: 504,
          retryable: true,
        });
      }
      return {
        startAt,
        total: 6,
        issues: [
          issue(`PROJ-${20 + startAt}`, '2026-07-17T13:00:00.000Z'),
          issue(`PROJ-${21 + startAt}`, '2026-07-17T13:00:00.000Z'),
        ],
      };
    });
    const run = await createRun();
    await expect(execute(service, run.id)).rejects.toMatchObject({
      code: 'EXTERNAL_REQUEST_TIMEOUT',
    });
    const cursorAfter = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_scope: { connectionId, scope: 'jira:incremental' } },
    });
    expect(cursorAfter.lastSuccessRunId).toBe(cursorBefore.lastSuccessRunId);
    expect((await prisma.jiraSyncRun.findUniqueOrThrow({ where: { id: run.id } })).pageCount).toBe(
      2,
    );
  });

  it('Jira 后续出现非空值时替代 Excel 补充，并保留可解释的来源历史', async () => {
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { status: 'healthy' },
    });
    const firstUpdated = '2026-07-17T14:00:00.000Z';
    const { service: initialService } = serviceWithPages(() => ({
      startAt: 0,
      total: 1,
      issues: [issue('PROJ-900', firstUpdated, { duedate: null })],
    }));
    const initialRun = await createRun();
    await execute(initialService, initialRun.id);
    const task = await prisma.task.findUniqueOrThrow({
      where: { connectionId_issueKey: { connectionId, issueKey: 'PROJ-900' } },
    });
    const excelObservation = await prisma.taskSourceObservation.create({
      data: {
        id: newId(),
        taskId: task.id,
        sourceType: 'excel',
        contentHash: requestHash({ taskId: task.id, dueDate: '2026-07-20' }),
        fieldsJson: JSON.stringify({ dueDate: '2026-07-20' }),
        observedAt: new Date(),
      },
    });
    await prisma.$transaction([
      prisma.task.update({ where: { id: task.id }, data: { dueDate: '2026-07-20' } }),
      prisma.taskFieldProvenance.create({
        data: {
          id: newId(),
          taskId: task.id,
          fieldName: 'dueDate',
          sourceType: 'excel',
          decision: 'supplement',
          valueJson: JSON.stringify('2026-07-20'),
          sourceObservationId: excelObservation.id,
          reason: '测试 Excel 补充值',
          active: true,
        },
      }),
    ]);

    const { service: laterService } = serviceWithPages(() => ({
      startAt: 0,
      total: 1,
      issues: [issue('PROJ-900', '2026-07-17T15:00:00.000Z', { duedate: '2026-07-25' })],
    }));
    const laterRun = await createRun();
    await execute(laterService, laterRun.id);

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(updated.dueDate).toBe('2026-07-25');
    const history = await prisma.taskFieldProvenance.findMany({
      where: { taskId: task.id, fieldName: 'dueDate' },
      orderBy: { createdAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      sourceType: 'excel',
      decision: 'supplement',
      active: false,
    });
    expect(history[0]?.supersededAt).not.toBeNull();
    expect(history[1]).toMatchObject({ sourceType: 'jira', decision: 'source_fact', active: true });
  });
});
