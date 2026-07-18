import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WorkCalendarService } from '../src/modules/settings/work-calendar.service.js';
import { generateWeeklyReportSchema } from '../src/modules/weekly-reports/weekly-report.schemas.js';
import { WeeklyReportService } from '../src/modules/weekly-reports/weekly-report.service.js';
import { WeeklyReportAttachmentService } from '../src/modules/weekly-reports/weekly-report-attachment.service.js';

describe('周报来源快照、不可变规则版本与周期重放', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let reports: WeeklyReportService;
  let attachments: WeeklyReportAttachmentService;
  let calendars: WorkCalendarService;
  const context = { correlationId: 'weekly-correlation', sessionId: 'weekly-session' };
  const now = new Date('2026-07-18T00:00:00.000Z');

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-weekly-snapshot-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'weekly.db').replaceAll('\\', '/')}`,
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
    const audit = new AuditService(prismaService);
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const security = {
      sessionHash: () => 'weekly-session-hash',
    } as unknown as LocalSecurityService;
    attachments = new WeeklyReportAttachmentService(
      {
        host: '127.0.0.1',
        port: 3760,
        dataDir: temporaryDirectory,
        webDist: join(temporaryDirectory, 'web'),
        databaseUrl: `file:${join(temporaryDirectory, 'weekly.db').replaceAll('\\', '/')}`,
        repositoryRoot: join(temporaryDirectory, 'repositories'),
        logLevel: 'error',
        environment: 'test',
      },
      prismaService,
      sessions,
      audit,
      security,
    );
    reports = new WeeklyReportService(prismaService, sessions, audit, security, attachments);
    calendars = new WorkCalendarService(prismaService, sessions, audit, security);
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-weekly-test',
        displayName: '周报验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.identityAlias.create({
      data: {
        id: 'weekly-git-email',
        profileId: 'local-user',
        aliasType: 'git_email',
        value: 'current@example.com',
        normalizedValue: 'current@example.com',
        source: 'user',
        enabled: true,
        verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    });
  }, 60_000);

  beforeEach(async () => {
    // 聚合根持有当前版本指针，清理隔离测试事实前先解除指针，历史表本身没有更新路径。
    await prisma.weeklyReport.updateMany({
      data: { currentVersionId: null, confirmedVersionId: null, currentConfirmationId: null },
    });
    await prisma.weeklyReportConfirmation.deleteMany();
    await prisma.weeklyReportAttachment.deleteMany();
    await prisma.workCalendar.updateMany({ data: { currentVersionId: null } });
    await prisma.reportSourceLink.deleteMany();
    await prisma.weeklyReportVersion.deleteMany();
    await prisma.reportSourceSnapshot.deleteMany();
    await prisma.weeklyReport.deleteMany();
    await prisma.workCalendarVersion.deleteMany();
    await prisma.workCalendar.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.evidenceLinkEvent.deleteMany();
    await prisma.evidenceLink.deleteMany();
    await prisma.evidence.deleteMany();
    await prisma.taskStatusEvent.deleteMany();
    await prisma.taskSourceObservation.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    await prisma.dingTalkTemplateMapping.updateMany({ data: { currentVersionId: null } });
    await prisma.dingTalkTemplateMappingVersion.deleteMany();
    await prisma.dingTalkTemplateMapping.deleteMany();
    await prisma.dingTalkRecipientValidation.deleteMany();
    await prisma.integrationConnection.deleteMany({ where: { type: 'dingtalk_log' } });
    await prisma.idempotencyRecord.deleteMany();
    await seedSourceFacts();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('创建不可变工作日历版本，并按节假日覆盖计算默认工作周', async () => {
    const created = await calendars.createVersion(
      {
        name: '企业研发日历',
        timezone: 'Asia/Shanghai',
        workingWeekdays: [1, 2, 3, 4, 5],
        dateOverrides: [
          { date: '2026-07-17', isWorkday: false, label: '调休日' },
          { date: '2026-07-18', isWorkday: true, label: '补班' },
        ],
        source: 'manual',
      },
      context,
    );
    expect(created).toMatchObject({ replayed: false, version: { versionNo: 1 } });
    const replay = await calendars.createVersion(
      {
        name: '企业研发日历',
        timezone: 'Asia/Shanghai',
        workingWeekdays: [5, 4, 3, 2, 1],
        dateOverrides: [
          { date: '2026-07-18', isWorkday: true, label: '补班' },
          { date: '2026-07-17', isWorkday: false, label: '调休日' },
        ],
        source: 'manual',
      },
      context,
    );
    expect(replay).toMatchObject({ replayed: true, version: { versionNo: 1 } });
    await calendars.createVersion(
      {
        name: '企业研发日历',
        timezone: 'Asia/Shanghai',
        workingWeekdays: [1, 2, 3, 4, 5],
        dateOverrides: [],
        source: 'manual',
      },
      context,
    );
    const restored = await calendars.createVersion(
      {
        name: '企业研发日历',
        timezone: 'Asia/Shanghai',
        workingWeekdays: [1, 2, 3, 4, 5],
        dateOverrides: [
          { date: '2026-07-17', isWorkday: false, label: '调休日' },
          { date: '2026-07-18', isWorkday: true, label: '补班' },
        ],
        source: 'manual',
      },
      context,
    );
    expect(restored).toMatchObject({ replayed: false, version: { versionNo: 3 } });

    const result = await reports.generate(
      baseInput({
        periodStart: undefined,
        periodEnd: undefined,
        reportDate: undefined,
        existingReportPolicy: 'reject',
      }),
      context,
      new Date('2026-07-15T03:00:00.000Z'),
    );
    expect(result.report).toMatchObject({
      periodStart: '2026-07-13',
      periodEnd: '2026-07-18',
      reportDate: '2026-07-18',
    });
    expect(result.sourceSnapshot).toMatchObject({ calendarVersionId: restored.version.id });
    await expect(
      prisma.workCalendarVersion.update({
        where: { id: created.version.id },
        data: { timezone: 'Asia/Shanghai' },
      }),
    ).rejects.toThrow();
  });

  it('在一个事务内冻结来源、生成六字段版本和段落级链接，并可从历史复现', async () => {
    const result = await reports.generate(
      baseInput({ includeUnconfirmedEvidence: true }),
      context,
      now,
    );
    expect(result).toMatchObject({
      replayed: false,
      report: { status: 'generated', version: 2, versionCount: 1 },
      version: {
        versionNo: 1,
        origin: 'rule',
        fields: { reportDate: '2026-07-17', problems: '暂无' },
      },
    });
    expect(result.version.fields.weeklyWork).toContain('PROJ-1 完成周报快照');
    expect(result.version.fields.weeklyWork).toContain('1 项Commit');
    expect(result.version.fields.weeklyWork).not.toContain('内部实现细节');
    expect(result.version.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: 'task', sourceId: 'task-1' }),
        expect.objectContaining({ sourceType: 'evidence', sourceId: 'evidence-1' }),
        expect.objectContaining({ sourceType: 'manual', sourceId: 'manual-other' }),
      ]),
    );
    expect(result.version.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'WORKDAY_CALENDAR_FALLBACK' }),
        expect.objectContaining({
          code: 'UNCONFIRMED_EVIDENCE',
          sourceRefs: [{ type: 'evidence', id: 'evidence-unlinked' }],
        }),
      ]),
    );
    expect(result.sourceSnapshot.sources.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'evidence-unlinked',
          taskId: null,
          relationStatus: 'suggested',
        }),
      ]),
    );
    expect(await prisma.weeklyReport.count()).toBe(1);
    expect(await prisma.reportSourceSnapshot.count()).toBe(1);
    expect(await prisma.weeklyReportVersion.count()).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'weekly_report.generated' } })).toBe(1);

    await prisma.task.update({ where: { id: 'task-1' }, data: { title: '来源随后发生变化' } });
    const historical = await reports.getVersion(result.report.id, result.version.id);
    expect(historical.fields.weeklyWork).toContain('完成周报快照');
    expect(
      historical.sourceLinks.find(
        (link: { sourceType: string; sourceId: string }) =>
          link.sourceType === 'task' && link.sourceId === 'task-1',
      )?.sourceSummary,
    ).toMatchObject({ title: '完成周报快照' });
    await expect(
      prisma.weeklyReportVersion.update({
        where: { id: result.version.id },
        data: { weeklyWorkText: '尝试改写历史' },
      }),
    ).rejects.toThrow();
  });

  it('严格新鲜度策略阻断旧来源，明确允许后把风险固化到版本', async () => {
    await prisma.task.update({
      where: { id: 'task-1' },
      data: { lastObservedAt: new Date('2026-07-10T00:00:00.000Z') },
    });
    await prisma.evidence.update({
      where: { id: 'evidence-1' },
      data: { sourceSyncedAt: new Date('2026-07-10T00:00:00.000Z') },
    });
    await expect(reports.generate(baseInput(), context, now)).rejects.toMatchObject({
      code: 'WEEKLY_REPORT_SOURCE_NOT_FRESH',
    });
    expect(await prisma.weeklyReport.count()).toBe(0);

    const generated = await reports.generate(
      baseInput({ freshnessPolicy: freshness('allow_stale') }),
      context,
      now,
    );
    expect(generated.version.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SOURCE_STALE' }),
        expect.objectContaining({ code: 'WORKDAY_CALENDAR_FALLBACK' }),
      ]),
    );
    expect(generated.sourceSnapshot.freshnessPolicy).toMatchObject({ mode: 'allow_stale' });
  });

  it('同周期默认冲突，明确重生成创建父子版本，同一来源重放不重复', async () => {
    const first = await reports.generate(baseInput(), context, now);
    await expect(reports.generate(baseInput(), context, now)).rejects.toMatchObject({
      code: 'WEEKLY_REPORT_PERIOD_EXISTS',
    });

    await prisma.task.update({
      where: { id: 'task-1' },
      data: { title: '完成周报快照第二版', version: { increment: 1 } },
    });
    const secondInput = baseInput({ existingReportPolicy: 'create_version' });
    const second = await reports.generate(secondInput, context, now);
    expect(second).toMatchObject({
      replayed: false,
      report: { id: first.report.id, version: 3, versionCount: 2 },
      version: { versionNo: 2, parentVersionId: first.version.id },
    });
    expect(second.version.fields.weeklyWork).toContain('第二版');
    const replay = await reports.generate(secondInput, context, now);
    expect(replay).toMatchObject({ replayed: true, version: { id: second.version.id } });
    expect(await prisma.weeklyReportVersion.count()).toBe(2);
    expect(await prisma.reportSourceSnapshot.count()).toBe(2);
    expect(await prisma.auditEvent.count({ where: { targetId: first.report.id } })).toBe(2);
  });

  it('列表、聚合详情、版本摘要和段落来源查询保持同一所有权边界', async () => {
    const generated = await reports.generate(baseInput(), context, now);
    const list = await reports.list({ limit: 20 });
    expect(list).toMatchObject({
      total: 1,
      items: [{ id: generated.report.id, currentVersionId: generated.version.id }],
      page: { hasMore: false, limit: 20 },
    });
    const detail = await reports.get(generated.report.id);
    expect(detail).toMatchObject({ id: generated.report.id, sourceSnapshotCount: 1 });
    const versions = await reports.listVersions(generated.report.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNo: 1, origin: 'rule' });
    expect(
      (await reports.getVersion(generated.report.id, generated.version.id)).sourceLinks.length,
    ).toBeGreaterThan(0);
    await expect(reports.get('missing-report')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('请求结构拒绝半套周期、重复人工来源和未启用 AI，不产生任何报告', async () => {
    expect(() => generateWeeklyReportSchema.parse({ periodStart: '2026-07-13' })).toThrow();
    expect(() =>
      generateWeeklyReportSchema.parse(baseInput({ periodStart: '2026-02-30' })),
    ).toThrow();
    expect(() =>
      generateWeeklyReportSchema.parse(
        baseInput({
          periodStart: '2026-07-13',
          periodEnd: '2026-07-17',
          reportDate: '2026-07-18',
        }),
      ),
    ).toThrow();
    await expect(
      reports.generate(
        baseInput({
          manualInputs: [
            { id: 'duplicate', field: 'other', text: '一', pinned: false },
            { id: 'duplicate', field: 'other', text: '二', pinned: false },
          ],
        }),
        context,
        now,
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_SOURCE_DUPLICATE' });
    await expect(
      reports.generate(baseInput({ aiProviderConfigId: 'provider-1' }), context, now),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_AI_PROVIDER_NOT_READY' });
    expect(await prisma.weeklyReport.count()).toBe(0);
  });

  it('SQLite 约束拒绝非法状态、版本来源和不一致的段落来源引用', async () => {
    const generated = await reports.generate(baseInput(), context, now);
    await expect(
      prisma.weeklyReport.update({
        where: { id: generated.report.id },
        data: { status: 'submitted_without_confirmation' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.weeklyReportVersion.create({
        data: {
          id: 'invalid-origin-version',
          reportId: generated.report.id,
          versionNo: 2,
          origin: 'tool_call',
          reportDateText: '2026-07-17',
          recentGoalsText: '',
          weeklyWorkText: '',
          nextWeekPlansText: '',
          problemsText: '暂无',
          otherText: '',
          fieldsJson: '{}',
          sourceSnapshotId: generated.sourceSnapshot.id,
          contentHash: 'invalid-origin-hash',
          createdBy: 'local-user',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reportSourceLink.create({
        data: {
          id: 'invalid-source-link',
          snapshotId: generated.sourceSnapshot.id,
          versionId: generated.version.id,
          fieldName: 'other',
          blockId: 'invalid-block',
          sourceType: 'task',
          sourceId: 'task-1',
          taskId: null,
          evidenceId: 'evidence-1',
          sourceContentHash: 'invalid-source-hash',
          sourceSummaryJson: '{}',
        },
      }),
    ).rejects.toThrow();
    await expect(
      calendars.createVersion(
        {
          name: '重复星期日历',
          timezone: 'Asia/Shanghai',
          workingWeekdays: [1, 1, 2],
          dateOverrides: [],
          source: 'manual',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORK_CALENDAR_WEEKDAY_DUPLICATE' });
  });

  it('编辑、附件、收件人、模板映射、warning 知悉、确认失效与历史恢复形成完整不可变链', async () => {
    const generated = await reports.generate(baseInput(), context, now);
    const mapping = await seedDingTalkConfirmationFacts();
    const attachment = await attachments.upload(
      generated.report.id,
      {
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
        fileName: '周报截图.png',
        mimeType: 'image/png',
      },
      context,
    );
    const editContext = await mutationContext('weekly-edit-0001', {
      action: 'edit',
      reportId: generated.report.id,
    });
    const edited = await reports.edit(
      generated.report.id,
      {
        baseVersionId: generated.version.id,
        reportVersion: generated.report.version,
        fields: { recentGoals: '完成周报不可变版本、确认门禁与恢复链路' },
        attachmentIds: [attachment.id],
        recipientValidationIds: ['recipient-validation-1'],
        templateMappingVersionId: mapping.id,
        scheduleAt: null,
        changeReason: '补全正式提交所需字段与验证事实',
      },
      editContext,
    );
    expect(edited).toMatchObject({
      replayed: false,
      report: { status: 'editing', version: 3, confirmedVersionId: null },
      version: {
        versionNo: 2,
        origin: 'manual',
        templateMappingVersionId: mapping.id,
        attachments: [{ id: attachment.id }],
        recipientScope: {
          connectionId: 'dingtalk-log-1',
          recipients: [{ validationId: 'recipient-validation-1' }],
        },
      },
    });
    expect(edited.version.sourceLinks.length).toBeGreaterThan(0);
    expect(
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: editContext.idempotencyRecordId },
      }),
    ).toMatchObject({ state: 'completed', httpStatus: 200 });
    await expect(
      prisma.weeklyReportVersion.update({
        where: { id: edited.version.id },
        data: { recentGoalsText: '尝试覆盖' },
      }),
    ).rejects.toThrow();
    await expect(
      attachments.remove(generated.report.id, attachment.id, context),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_ATTACHMENT_IN_USE' });

    const staleEditContext = await mutationContext('weekly-edit-stale-1', {
      action: 'stale-edit',
    });
    await expect(
      reports.edit(
        generated.report.id,
        {
          baseVersionId: generated.version.id,
          reportVersion: generated.report.version,
          fields: { other: '过期页面写入' },
          changeReason: '模拟并发冲突',
        },
        staleEditContext,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const warningIds = edited.version.warnings.map((warning: { id: string }) => warning.id);
    const missingAckContext = await mutationContext('weekly-confirm-missing-ack', {
      action: 'confirm-without-ack',
    });
    await expect(
      reports.confirm(
        generated.report.id,
        {
          versionId: edited.version.id,
          reportVersion: edited.report.version,
          templateMappingVersionId: mapping.id,
          acknowledgedWarningIds: [],
        },
        missingAckContext,
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_WARNINGS_NOT_ACKNOWLEDGED' });

    const confirmContext = await mutationContext('weekly-confirm-0001', {
      action: 'confirm',
      warningIds,
    });
    const confirmed = await reports.confirm(
      generated.report.id,
      {
        versionId: edited.version.id,
        reportVersion: edited.report.version,
        templateMappingVersionId: mapping.id,
        acknowledgedWarningIds: warningIds,
      },
      confirmContext,
    );
    expect(confirmed).toMatchObject({
      replayed: false,
      confirmation: {
        status: 'active',
        versionId: edited.version.id,
        contentHash: edited.version.contentHash,
      },
      report: { status: 'confirmed', version: 4, confirmedVersionId: edited.version.id },
    });
    const confirmationId = confirmed.confirmation.id;

    const removeAttachmentContext = await mutationContext('weekly-edit-remove-attachment', {
      action: 'remove-attachment-from-version',
    });
    const afterConfirmationEdit = await reports.edit(
      generated.report.id,
      {
        baseVersionId: edited.version.id,
        reportVersion: confirmed.report.version,
        fields: { other: '确认后修改会自动失效旧确认' },
        attachmentIds: [],
        changeReason: '验证确认失效规则',
      },
      removeAttachmentContext,
    );
    expect(afterConfirmationEdit.report).toMatchObject({
      status: 'editing',
      version: 5,
      confirmedVersionId: null,
      currentConfirmation: null,
    });
    expect(
      await prisma.weeklyReportConfirmation.findUniqueOrThrow({
        where: { id: confirmationId },
      }),
    ).toMatchObject({ status: 'invalidated', invalidationReason: '正文或提交元数据已生成新版本' });
    expect(
      (await attachments.remove(generated.report.id, attachment.id, context)).attachment,
    ).toMatchObject({
      status: 'deleted',
    });

    const restoreContext = await mutationContext('weekly-restore-0001', {
      action: 'restore',
      targetVersionId: generated.version.id,
    });
    const restored = await reports.restore(
      generated.report.id,
      generated.version.id,
      {
        baseVersionId: afterConfirmationEdit.version.id,
        reportVersion: afterConfirmationEdit.report.version,
        changeReason: '撤销后续编辑，恢复初始规则版本',
      },
      restoreContext,
    );
    expect(restored).toMatchObject({
      report: { status: 'editing', version: 6 },
      version: {
        versionNo: 4,
        origin: 'restore',
        fields: { recentGoals: generated.version.fields.recentGoals },
        changeSummary: { restoredFromVersionId: generated.version.id },
      },
    });
    expect(
      await prisma.weeklyReportVersion.count({ where: { reportId: generated.report.id } }),
    ).toBe(4);
    expect(
      await prisma.auditEvent.count({ where: { targetId: generated.report.id } }),
    ).toBeGreaterThanOrEqual(5);
  });

  function baseInput(overrides: Partial<ReturnType<typeof generateWeeklyReportSchema.parse>> = {}) {
    return generateWeeklyReportSchema.parse({
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      reportDate: '2026-07-17',
      freshnessPolicy: freshness('require_fresh'),
      includeUnconfirmedEvidence: false,
      manualInputs: [
        {
          id: 'manual-other',
          field: 'other',
          text: '参加架构评审并沉淀结论',
        },
      ],
      ...overrides,
    });
  }

  function freshness(mode: 'require_fresh' | 'allow_stale') {
    return { mode, taskMaxAgeMinutes: 1_440, evidenceMaxAgeMinutes: 1_440 } as const;
  }

  async function mutationContext(key: string, request: unknown) {
    const record = await prisma.idempotencyRecord.create({
      data: {
        id: `idempotency-${key}`,
        actorId: 'local-user',
        route: `/test/${key}`,
        idempotencyKey: key,
        requestHash: JSON.stringify(request),
      },
    });
    return { ...context, idempotencyRecordId: record.id };
  }

  async function seedDingTalkConfirmationFacts() {
    const capabilitySnapshotHash = 'a'.repeat(64);
    await prisma.integrationConnection.create({
      data: {
        id: 'dingtalk-log-1',
        type: 'dingtalk_log',
        name: '研发周报日志',
        enabled: true,
        status: 'healthy',
        capabilitiesJson: JSON.stringify({
          templateDiscovery: { supported: true, snapshotHash: capabilitySnapshotHash },
        }),
      },
    });
    const aggregate = await prisma.dingTalkTemplateMapping.create({
      data: { id: 'template-mapping-1', connectionId: 'dingtalk-log-1' },
    });
    const fields = [
      'reportDate',
      'recentGoals',
      'weeklyWork',
      'nextWeekPlans',
      'problems',
      'other',
    ].map((internalField, order) => ({
      internalField,
      externalFieldId: `external-${order}`,
      externalFieldName: `字段${order}`,
      externalType: 'text',
      order,
      required: true,
      maxLength: 50_000,
    }));
    const mapping = await prisma.dingTalkTemplateMappingVersion.create({
      data: {
        id: 'template-mapping-version-1',
        mappingId: aggregate.id,
        versionNo: 1,
        templateId: 'weekly-template',
        templateName: '研发周报',
        externalTemplateVersion: '2026-07',
        templateHash: 'b'.repeat(64),
        fieldsJson: JSON.stringify(fields),
        capabilitySnapshotHash,
        observedAt: new Date('2026-07-18T00:00:00.000Z'),
        expiresAt: new Date('2027-07-18T00:00:00.000Z'),
        contentHash: 'c'.repeat(64),
        createdBy: 'local-user',
      },
    });
    await prisma.dingTalkTemplateMapping.update({
      where: { id: aggregate.id },
      data: { currentVersionId: mapping.id, version: { increment: 1 } },
    });
    await prisma.dingTalkRecipientValidation.create({
      data: {
        id: 'recipient-validation-1',
        connectionId: 'dingtalk-log-1',
        subjectType: 'user',
        externalId: 'user-1001',
        displayName: '周报接收人',
        available: true,
        capabilitySnapshotHash,
        observedAt: new Date('2026-07-18T00:00:00.000Z'),
        expiresAt: new Date('2027-07-18T00:00:00.000Z'),
        contentHash: 'd'.repeat(64),
      },
    });
    return mapping;
  }

  async function seedSourceFacts() {
    await prisma.project.create({
      data: { id: 'project-1', name: '研发平台', jiraProjectKey: 'PROJ' },
    });
    await prisma.task.create({
      data: {
        id: 'task-1',
        projectId: 'project-1',
        primarySource: 'jira',
        issueKey: 'PROJ-1',
        projectKey: 'PROJ',
        title: '完成周报快照',
        normalizedStatus: 'in_progress',
        isCurrentUser: true,
        plannedStartDate: '2026-07-13',
        dueDate: '2026-07-20',
        sprintIdsJson: JSON.stringify([{ id: 'sprint-1', state: 'active' }]),
        lastObservedAt: new Date('2026-07-17T01:00:00.000Z'),
      },
    });
    await prisma.evidence.create({
      data: {
        id: 'evidence-1',
        sourceType: 'commit',
        sourceInternalId: 'weekly-commit-1',
        sourceExternalKey: 'abcdef01',
        projectId: 'project-1',
        eventAt: new Date('2026-07-16T01:00:00.000Z'),
        title: 'PROJ-1 内部实现细节',
        contentHash: 'weekly-evidence-hash-1',
        sourceSyncedAt: new Date('2026-07-17T01:30:00.000Z'),
      },
    });
    await prisma.evidence.create({
      data: {
        id: 'evidence-unlinked',
        sourceType: 'commit',
        sourceInternalId: 'weekly-commit-unlinked',
        sourceExternalKey: 'abcdef02',
        projectId: 'project-1',
        eventAt: new Date('2026-07-16T03:00:00.000Z'),
        title: '尚未关联任务的当前用户 Commit',
        contentHash: 'weekly-evidence-hash-unlinked',
        metadataJson: JSON.stringify({ authorEmail: 'CURRENT@example.com' }),
        sourceSyncedAt: new Date('2026-07-17T02:00:00.000Z'),
      },
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
        status: 'confirmed',
        explanation: 'Commit 命中 PROJ-1',
        ruleVersion: 'evidence-rule-v1',
        sourceContentHash: 'weekly-evidence-hash-1',
        confirmedBy: 'local-user',
        confirmedAt: new Date('2026-07-17T02:00:00.000Z'),
      },
    });
  }
});
