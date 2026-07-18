import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { DingTalkLogClient } from '../src/modules/dingtalk/dingtalk-log.client.js';
import type { DingTalkRobotClient } from '../src/modules/dingtalk/dingtalk-robot.client.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WeeklyReportDeliveryHandler } from '../src/modules/weekly-reports/weekly-report-delivery.handler.js';
import { WeeklyReportDeliveryRecoveryService } from '../src/modules/weekly-reports/weekly-report-delivery-recovery.service.js';
import { WeeklyReportDeliveryService } from '../src/modules/weekly-reports/weekly-report-delivery.service.js';
import { WeeklyReportNotificationLedgerService } from '../src/modules/weekly-reports/weekly-report-notification-ledger.service.js';

const capabilityHash = 'a'.repeat(64);
const recipientHash = 'b'.repeat(64);
const emptyAttachmentsHash = 'c'.repeat(64);
const contentHash = 'd'.repeat(64);
const weeklyFields = [
  'reportDate',
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
] as const;

describe('周报钉钉正式日志与机器人双通道交付', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let sequence = 0;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-weekly-delivery-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'delivery.db').replaceAll('\\', '/')}`,
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
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-weekly-delivery',
        displayName: '双通道验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('正式日志只创建一次，明确成功后才发送不含全文的群摘要', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockResolvedValue({
      reportId: 'external-report-1001',
      requestId: 'provider-log-request',
    });
    const sendText = vi.fn().mockResolvedValue({
      requestId: 'provider-robot-request',
      timestamp: 1,
      providerCallCount: 3,
      retryDelaysMs: [250, 500],
    });
    const runtime = createRuntime(createReport, sendText);

    const firstIdempotency = await seedIdempotency(fixture.suffix, 'submit-1');
    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(firstIdempotency),
    );
    const logIntentId = requested.intent.id;
    expect(requested).toMatchObject({ replayed: false, intent: { status: 'pending' } });
    expect(await prisma.job.count({ where: { payloadRef: logIntentId } })).toBe(1);

    const duplicateIdempotency = await seedIdempotency(fixture.suffix, 'submit-2');
    const replay = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        // 重复点击允许携带首次请求前的聚合版本，但只能重放同一个交付意图。
        reportVersion: fixture.reportVersion,
      },
      context(duplicateIdempotency),
    );
    expect(replay).toMatchObject({ replayed: true, intent: { id: logIntentId } });
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(1);

    const logResult = await execute(runtime.handler, logIntentId);
    expect(logResult).toMatchObject({ status: 'succeeded', externalId: 'external-report-1001' });
    expect(createReport).toHaveBeenCalledOnce();
    expect(createReport.mock.calls[0]![0]).toMatchObject({
      templateId: fixture.templateId,
      toUserIds: ['recipient-user'],
      toChat: false,
      source: 'auto-work',
    });
    const submittedCall = createReport.mock.calls[0]![0] as Parameters<
      DingTalkLogClient['createReport']
    >[0];
    const submittedContents = submittedCall.contents;
    expect(submittedContents).toHaveLength(6);
    expect(new Set(submittedContents.map((field) => field.key)).size).toBe(6);
    expect(submittedContents.map((field) => field.content)).toContain(
      '仅正式日志可见的完整工作正文',
    );

    const current = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    const notifyIdempotency = await seedIdempotency(fixture.suffix, 'notify-1');
    const notification = await runtime.service.notifyGroup(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        robotConnectionId: fixture.robotConnectionId,
        notificationType: 'submission_success',
        reportVersion: current.version,
      },
      context(notifyIdempotency),
    );
    const robotIntentId = notification.intent.id;
    await execute(runtime.handler, robotIntentId);

    expect(sendText).toHaveBeenCalledOnce();
    const sentCall = sendText.mock.calls[0]![0] as Parameters<DingTalkRobotClient['sendText']>[0];
    const message = sentCall.text;
    expect(message).toContain('状态：已提交钉钉正式日志');
    expect(message).toContain('正式日志 ID：external-report-1001');
    expect(message).toContain('项目甲');
    expect(message).not.toContain('仅正式日志可见的完整工作正文');
    expect(message).not.toContain('localhost');
    const finalReport = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    expect(finalReport).toMatchObject({
      logDeliveryState: 'submitted',
      robotDeliveryState: 'notified',
    });
    const listed = await runtime.service.list(fixture.reportId);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: logIntentId, status: 'succeeded', attemptCount: 1 }),
        expect.objectContaining({ id: robotIntentId, status: 'succeeded', attemptCount: 1 }),
      ]),
    );
    const robotAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
      where: { intentId: robotIntentId },
    });
    expect(JSON.parse(robotAttempt.responseSummaryJson)).toMatchObject({
      providerCallCount: 3,
      retryDelaysMs: [250, 500],
    });
    const notificationFact = await prisma.robotNotification.findFirstOrThrow({
      where: { deliveryIntentId: robotIntentId },
    });
    expect(notificationFact).toMatchObject({
      notificationType: 'submission_success',
      businessObjectKey: `weekly-report:${fixture.reportId}`,
      status: 'succeeded',
      providerRequestId: 'provider-robot-request',
      coalescedCount: 0,
    });
    expect(JSON.stringify(notificationFact)).not.toContain('仅正式日志可见的完整工作正文');
    expect(
      await runtime.notificationLedger.reserve({
        reportId: fixture.reportId,
        connectionId: fixture.robotConnectionId,
        notificationType: 'submission_success',
        businessObjectKey: notificationFact.businessObjectKey,
        stateVersion: notificationFact.stateVersion,
        contentHash: notificationFact.contentHash,
        quietWindowMinutes: 30,
        scheduledFor: new Date(),
      }),
    ).toMatchObject({ disposition: 'duplicate' });
    const coalesced = await runtime.notificationLedger.reserve({
      reportId: fixture.reportId,
      connectionId: fixture.robotConnectionId,
      notificationType: 'submission_success',
      businessObjectKey: notificationFact.businessObjectKey,
      stateVersion: notificationFact.stateVersion + 1,
      contentHash: notificationFact.contentHash,
      quietWindowMinutes: 30,
      scheduledFor: new Date(),
    });
    expect(coalesced.disposition).toBe('coalesced');
    expect(coalesced.notification).toMatchObject({
      id: notificationFact.id,
      coalescedCount: 1,
    });
  });

  it('群通知失败保持正式日志成功事实，并形成可见的部分交付状态', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi
      .fn()
      .mockResolvedValue({ reportId: 'external-report-2002', requestId: null });
    const sendText = vi.fn().mockRejectedValue(
      new DomainError('DINGTALK_ROBOT_RESPONSE_ERROR', '机器人连续三次返回 503', {
        httpStatus: 503,
        retryable: true,
        details: { providerCallCount: 3, retryDelaysMs: [250, 500] },
      }),
    );
    const runtime = createRuntime(createReport, sendText);
    const submitIdempotency = await seedIdempotency(fixture.suffix, 'partial-submit');
    const log = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitIdempotency),
    );
    await execute(runtime.handler, log.intent.id);
    const afterLog = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    const notifyIdempotency = await seedIdempotency(fixture.suffix, 'partial-notify');
    const robot = await runtime.service.notifyGroup(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        robotConnectionId: fixture.robotConnectionId,
        notificationType: 'submission_success',
        reportVersion: afterLog.version,
      },
      context(notifyIdempotency),
    );
    const result = await execute(runtime.handler, robot.intent.id);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'DINGTALK_ROBOT_RESPONSE_ERROR' });
    expect(
      await prisma.weeklyReport.findUniqueOrThrow({ where: { id: fixture.reportId } }),
    ).toMatchObject({
      logDeliveryState: 'submitted',
      robotDeliveryState: 'failed',
    });
    expect(
      await prisma.deliveryIntent.findUniqueOrThrow({ where: { id: log.intent.id } }),
    ).toMatchObject({
      status: 'succeeded',
      externalId: 'external-report-2002',
    });
    const failedAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
      where: { intentId: robot.intent.id },
    });
    expect(JSON.parse(failedAttempt.responseSummaryJson)).toMatchObject({
      status: 'failed',
      providerCallCount: 3,
      retryDelaysMs: [250, 500],
    });
  });

  it('超时结果进入 unknown 且重复请求不会盲目创建第二次外部调用', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockRejectedValue(
      new DomainError('EXTERNAL_REQUEST_TIMEOUT', '钉钉响应超时，结果未知', {
        httpStatus: 503,
        retryable: true,
      }),
    );
    const runtime = createRuntime(createReport, vi.fn());
    const submitIdempotency = await seedIdempotency(fixture.suffix, 'unknown-submit');
    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitIdempotency),
    );
    await expect(execute(runtime.handler, requested.intent.id)).rejects.toMatchObject({
      code: 'DINGTALK_DELIVERY_RESULT_UNKNOWN',
      options: { suggestedAction: 'manual_review' },
    });
    expect(
      await prisma.deliveryIntent.findUniqueOrThrow({ where: { id: requested.intent.id } }),
    ).toMatchObject({ status: 'unknown', lastErrorCode: 'EXTERNAL_REQUEST_TIMEOUT' });

    const duplicateIdempotency = await seedIdempotency(fixture.suffix, 'unknown-replay');
    const replay = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(duplicateIdempotency),
    );
    expect(replay).toMatchObject({ replayed: true, intent: { status: 'unknown' } });
    expect(createReport).toHaveBeenCalledOnce();
    expect(await prisma.deliveryAttempt.count({ where: { intentId: requested.intent.id } })).toBe(
      1,
    );
  });

  it('未知结果只在六字段唯一匹配时恢复成功，并保留原尝试的 unknown 事实', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockRejectedValue(
      new DomainError('EXTERNAL_REQUEST_TIMEOUT', '钉钉响应超时，结果未知', {
        httpStatus: 503,
        retryable: true,
      }),
    );
    const listReports = vi.fn().mockResolvedValue({
      reports: [matchingProviderReport('recovered-report-3003')],
      nextCursor: 0,
      hasMore: false,
      requestId: 'recovery-query-1',
    });
    const runtime = createRuntime(createReport, vi.fn(), listReports);
    const submitIdempotency = await seedIdempotency(fixture.suffix, 'recover-submit');
    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitIdempotency),
    );
    await expect(execute(runtime.handler, requested.intent.id)).rejects.toMatchObject({
      code: 'DINGTALK_DELIVERY_RESULT_UNKNOWN',
    });
    const unknown = await prisma.deliveryIntent.findUniqueOrThrow({
      where: { id: requested.intent.id },
    });
    const reconcileIdempotency = await seedIdempotency(fixture.suffix, 'recover-query');
    const recovered = await runtime.recovery.reconcile(
      fixture.reportId,
      requested.intent.id,
      { intentVersion: unknown.version },
      context(reconcileIdempotency),
    );

    expect(recovered).toMatchObject({
      status: 'succeeded',
      recoveryStatus: 'matched',
      externalId: 'recovered-report-3003',
      exactMatchCount: 1,
    });
    expect(createReport).toHaveBeenCalledOnce();
    expect(listReports).toHaveBeenCalledOnce();
    expect(
      await prisma.deliveryAttempt.findFirstOrThrow({ where: { intentId: requested.intent.id } }),
    ).toMatchObject({ status: 'unknown' });
    expect(
      await prisma.deliveryRecoveryCheck.findFirstOrThrow({
        where: { intentId: requested.intent.id },
      }),
    ).toMatchObject({ outcome: 'matched', matchedExternalId: 'recovered-report-3003' });
  });

  it('连续两次零匹配并满足可见性宽限后才允许显式重试', async () => {
    vi.useFakeTimers();
    const base = new Date();
    vi.setSystemTime(base);
    try {
      const fixture = await seedConfirmedReport();
      const createReport = vi
        .fn()
        .mockRejectedValueOnce(
          new DomainError('EXTERNAL_REQUEST_TIMEOUT', '第一次创建响应超时', {
            httpStatus: 503,
            retryable: true,
          }),
        )
        .mockResolvedValueOnce({ reportId: 'retry-created-4004', requestId: 'retry-request' });
      const listReports = vi.fn().mockResolvedValue({
        reports: [],
        nextCursor: 0,
        hasMore: false,
        requestId: 'absence-query',
      });
      const runtime = createRuntime(createReport, vi.fn(), listReports);
      const submitIdempotency = await seedIdempotency(fixture.suffix, 'absence-submit');
      const requested = await runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
        },
        context(submitIdempotency),
      );
      await expect(execute(runtime.handler, requested.intent.id)).rejects.toMatchObject({
        code: 'DINGTALK_DELIVERY_RESULT_UNKNOWN',
      });

      vi.setSystemTime(new Date(base.getTime() + 121_000));
      const firstUnknown = await prisma.deliveryIntent.findUniqueOrThrow({
        where: { id: requested.intent.id },
      });
      const firstQueryIdempotency = await seedIdempotency(fixture.suffix, 'absence-query-1');
      const firstQuery = await runtime.recovery.reconcile(
        fixture.reportId,
        requested.intent.id,
        { intentVersion: firstUnknown.version },
        context(firstQueryIdempotency),
      );
      expect(firstQuery).toMatchObject({
        status: 'unknown',
        recoveryStatus: 'not_found',
        retryAllowed: false,
      });

      vi.setSystemTime(new Date(base.getTime() + 152_000));
      const secondUnknown = await prisma.deliveryIntent.findUniqueOrThrow({
        where: { id: requested.intent.id },
      });
      const secondQueryIdempotency = await seedIdempotency(fixture.suffix, 'absence-query-2');
      const secondQuery = await runtime.recovery.reconcile(
        fixture.reportId,
        requested.intent.id,
        { intentVersion: secondUnknown.version },
        context(secondQueryIdempotency),
      );
      expect(secondQuery).toMatchObject({
        status: 'failed',
        recoveryStatus: 'absence_confirmed',
        retryAllowed: true,
      });

      const retryable = await prisma.deliveryIntent.findUniqueOrThrow({
        where: { id: requested.intent.id },
      });
      const retryIdempotency = await seedIdempotency(fixture.suffix, 'absence-retry');
      const retry = await runtime.recovery.retry(
        fixture.reportId,
        requested.intent.id,
        { intentVersion: retryable.version, reason: '已连续查询确认钉钉中不存在该日志' },
        context(retryIdempotency),
      );
      expect(retry).toMatchObject({ status: 'pending', nextAttemptNo: 2 });
      await execute(runtime.handler, requested.intent.id);
      expect(createReport).toHaveBeenCalledTimes(2);
      expect(
        await prisma.deliveryIntent.findUniqueOrThrow({ where: { id: requested.intent.id } }),
      ).toMatchObject({ status: 'succeeded', externalId: 'retry-created-4004', attemptCount: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('多条精确命中转待复核，并要求确认短语和外部 ID 才能人工裁决成功', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockRejectedValue(
      new DomainError('EXTERNAL_REQUEST_TIMEOUT', '创建结果未知', {
        httpStatus: 503,
        retryable: true,
      }),
    );
    const runtime = createRuntime(
      createReport,
      vi.fn(),
      vi.fn().mockResolvedValue({
        reports: [matchingProviderReport('ambiguous-a'), matchingProviderReport('ambiguous-b')],
        nextCursor: 0,
        hasMore: false,
        requestId: null,
      }),
    );
    const submitIdempotency = await seedIdempotency(fixture.suffix, 'manual-submit');
    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitIdempotency),
    );
    await expect(execute(runtime.handler, requested.intent.id)).rejects.toBeInstanceOf(DomainError);
    const unknown = await prisma.deliveryIntent.findUniqueOrThrow({
      where: { id: requested.intent.id },
    });
    const queryIdempotency = await seedIdempotency(fixture.suffix, 'manual-query');
    await runtime.recovery.reconcile(
      fixture.reportId,
      requested.intent.id,
      { intentVersion: unknown.version },
      context(queryIdempotency),
    );
    const review = await prisma.deliveryIntent.findUniqueOrThrow({
      where: { id: requested.intent.id },
    });
    expect(review).toMatchObject({ status: 'needs_review', recoveryStatus: 'ambiguous' });
    const resolveIdempotency = await seedIdempotency(fixture.suffix, 'manual-resolve');
    const resolved = await runtime.recovery.resolve(
      fixture.reportId,
      requested.intent.id,
      {
        intentVersion: review.version,
        resolution: 'delivered',
        externalId: 'ambiguous-a',
        externalUrl: null,
        reason: '已在钉钉客户端逐项核对并确认第一条为本次周报',
        confirmationPhrase: '我已在钉钉人工核对交付结果',
      },
      context(resolveIdempotency),
    );
    expect(resolved).toMatchObject({ status: 'succeeded', recoveryStatus: 'manual_succeeded' });
  });

  it('拒绝带附件或已过期模板事实的正式提交', async () => {
    const withAttachment = await seedConfirmedReport({ hasAttachment: true });
    const runtime = createRuntime(vi.fn(), vi.fn());
    const attachmentIdempotency = await seedIdempotency(withAttachment.suffix, 'attachment');
    await expect(
      runtime.service.submitLog(
        withAttachment.reportId,
        {
          confirmationId: withAttachment.confirmationId,
          confirmedVersionId: withAttachment.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: withAttachment.reportVersion,
        },
        context(attachmentIdempotency),
      ),
    ).rejects.toMatchObject({ code: 'DINGTALK_LOG_ATTACHMENTS_UNSUPPORTED' });

    const expired = await seedConfirmedReport({ expiredMapping: true });
    const expiredIdempotency = await seedIdempotency(expired.suffix, 'expired');
    await expect(
      runtime.service.submitLog(
        expired.reportId,
        {
          confirmationId: expired.confirmationId,
          confirmedVersionId: expired.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: expired.reportVersion,
        },
        context(expiredIdempotency),
      ),
    ).rejects.toMatchObject({ code: 'DINGTALK_LOG_CAPABILITY_CHANGED' });
  });

  function createRuntime(
    createReport: ReturnType<typeof vi.fn>,
    sendText: ReturnType<typeof vi.fn>,
    listReports: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
      reports: [],
      nextCursor: 0,
      hasMore: false,
      requestId: null,
    }),
  ) {
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const audit = new AuditService(prismaService);
    const security = {
      sessionHash: () => 'delivery-session-hash',
    } as unknown as LocalSecurityService;
    const notificationLedger = new WeeklyReportNotificationLedgerService(prismaService);
    const service = new WeeklyReportDeliveryService(
      prismaService,
      sessions,
      audit,
      security,
      notificationLedger,
    );
    const registry = new JobRegistryService();
    const logClient = {
      accessToken: vi
        .fn()
        .mockResolvedValue({ value: 'access-token', source: 'oauth2', expiresAt: null }),
      createReport,
      listReports,
    } as unknown as DingTalkLogClient;
    const robotClient = { sendText } as unknown as DingTalkRobotClient;
    const vault = {
      get: vi.fn((reference: string) =>
        Promise.resolve(
          reference.includes('robot')
            ? JSON.stringify({
                webhook: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
                secret: 'SEC-test-secret',
              })
            : JSON.stringify({ appSecret: 'app-secret' }),
        ),
      ),
    } as unknown as CredentialVault;
    const handler = new WeeklyReportDeliveryHandler(
      registry,
      prismaService,
      logClient,
      robotClient,
      vault,
    );
    handler.onModuleInit();
    const recovery = new WeeklyReportDeliveryRecoveryService(
      prismaService,
      sessions,
      audit,
      security,
      logClient,
      vault,
    );
    expect(registry.get('weekly-report.delivery')).toBe(handler);
    return { service, handler, recovery, notificationLedger };
  }

  function matchingProviderReport(reportId: string) {
    const values = [
      '2026-07-18',
      '完成迭代目标',
      '仅正式日志可见的完整工作正文',
      '继续交付',
      '暂无',
      '无',
    ];
    return {
      reportId,
      creatorId: 'operator-user',
      templateName: '研发周报',
      createTime: Date.now(),
      contents: values.map((value, index) => ({
        key: `钉钉字段 ${index + 1}`,
        sort: String(index),
        type: '1',
        value,
      })),
    };
  }

  async function seedConfirmedReport(options?: {
    hasAttachment?: boolean;
    expiredMapping?: boolean;
  }) {
    sequence += 1;
    const suffix = String(sequence);
    const logConnectionId = `delivery-log-${suffix}`;
    const robotConnectionId = `delivery-robot-${suffix}`;
    const mappingId = `delivery-mapping-${suffix}`;
    const mappingVersionId = `delivery-mapping-version-${suffix}`;
    const reportId = `delivery-report-${suffix}`;
    const snapshotId = `delivery-snapshot-${suffix}`;
    const versionId = `delivery-version-${suffix}`;
    const confirmationId = `delivery-confirmation-${suffix}`;
    const templateId = `weekly-template-${suffix}`;
    const periodStart = `2026-${suffix.padStart(2, '0')}-01`;
    const periodEnd = `2026-${suffix.padStart(2, '0')}-05`;
    const reportDate = `2026-${suffix.padStart(2, '0')}-06`;
    const now = new Date();

    await prisma.integrationConnection.createMany({
      data: [
        {
          id: logConnectionId,
          type: 'dingtalk_log',
          name: `正式日志 ${suffix}`,
          baseUrl: 'https://oapi.dingtalk.com/',
          credentialRef: `vault:log:${suffix}`,
          enabled: true,
          status: 'healthy',
          capabilitiesJson: JSON.stringify({ templateDiscovery: { snapshotHash: capabilityHash } }),
          configJson: JSON.stringify({ appKey: 'app-key', operatorUserId: 'operator-user' }),
        },
        {
          id: robotConnectionId,
          type: 'dingtalk_robot',
          name: `群通知 ${suffix}`,
          credentialRef: `vault:robot:${suffix}`,
          enabled: true,
          status: 'healthy',
          capabilitiesJson: JSON.stringify({ fullReportForbidden: true }),
          configJson: JSON.stringify({ robotName: '研发群机器人', groupId: 'group-1' }),
        },
      ],
    });
    await prisma.dingTalkTemplateMapping.create({
      data: { id: mappingId, connectionId: logConnectionId },
    });
    const fields = weeklyFields.map((internalField, order) => ({
      internalField,
      externalFieldId: `external-field-${order}`,
      externalFieldName: `钉钉字段 ${order + 1}`,
      externalType: '1',
      order,
      required: true,
      maxLength: null,
    }));
    await prisma.dingTalkTemplateMappingVersion.create({
      data: {
        id: mappingVersionId,
        mappingId,
        versionNo: 1,
        templateId,
        templateName: '研发周报',
        templateHash: 'e'.repeat(64),
        fieldsJson: JSON.stringify(fields),
        capabilitySnapshotHash: capabilityHash,
        observedAt: new Date(now.getTime() - 60_000),
        expiresAt: options?.expiredMapping
          ? new Date(now.getTime() - 1_000)
          : new Date(now.getTime() + 86_400_000),
        contentHash: 'f'.repeat(64),
        createdBy: 'local-user',
      },
    });
    await prisma.dingTalkTemplateMapping.update({
      where: { id: mappingId },
      data: { currentVersionId: mappingVersionId, version: { increment: 1 } },
    });
    const recipientValidationId = `delivery-recipient-${suffix}`;
    await prisma.dingTalkRecipientValidation.create({
      data: {
        id: recipientValidationId,
        connectionId: logConnectionId,
        subjectType: 'user',
        externalId: 'recipient-user',
        displayName: '接收人',
        available: true,
        capabilitySnapshotHash: capabilityHash,
        observedAt: new Date(now.getTime() - 60_000),
        expiresAt: new Date(now.getTime() + 86_400_000),
        contentHash,
      },
    });
    await prisma.weeklyReport.create({
      data: {
        id: reportId,
        ownerProfileId: 'local-user',
        periodStart,
        periodEnd,
        reportDate,
        templateName: '研发周报',
        templateMappingVersionId: mappingVersionId,
      },
    });
    await prisma.reportSourceSnapshot.create({
      data: {
        id: snapshotId,
        reportId,
        periodStart,
        periodEnd,
        reportDate,
        timezone: 'Asia/Shanghai',
        profileId: 'local-user',
        profileVersion: 1,
        taskFactsJson: JSON.stringify([{ projectName: '项目甲' }, { projectName: '项目乙' }]),
        evidenceFactsJson: '[]',
        freshnessPolicyJson: '{}',
        ruleVersion: 'weekly-rule-v1',
        templateMappingVersionId: mappingVersionId,
        sanitizationPolicyVersion: 'weekly-sanitization-v1',
        generationHash: `generation-${suffix}`,
        sourceContentHash: '1'.repeat(64),
        createdBy: 'local-user',
      },
    });
    const recipients = [
      {
        validationId: recipientValidationId,
        subjectType: 'user',
        externalId: 'recipient-user',
        displayName: '接收人',
        contentHash,
      },
    ];
    const attachments = options?.hasAttachment
      ? [{ id: `attachment-${suffix}`, name: '验收附件.pdf', contentHash: '2'.repeat(64) }]
      : [];
    await prisma.weeklyReportVersion.create({
      data: {
        id: versionId,
        reportId,
        versionNo: 1,
        origin: 'rule',
        reportDateText: '2026-07-18',
        recentGoalsText: '完成迭代目标',
        weeklyWorkText: '仅正式日志可见的完整工作正文',
        nextWeekPlansText: '继续交付',
        problemsText: '暂无',
        otherText: '无',
        fieldsJson: '{}',
        attachmentsJson: JSON.stringify(attachments),
        recipientScopeJson: JSON.stringify({ recipients }),
        templateMappingVersionId: mappingVersionId,
        sourceSnapshotId: snapshotId,
        contentHash: '3'.repeat(64),
        createdBy: 'local-user',
      },
    });
    await prisma.weeklyReportConfirmation.create({
      data: {
        id: confirmationId,
        reportId,
        versionId,
        reportAggregateVersion: 1,
        contentHash: '3'.repeat(64),
        templateMappingVersionId: mappingVersionId,
        warningAcknowledgementsJson: '[]',
        recipientScopeHash: recipientHash,
        attachmentsHash: options?.hasAttachment ? '4'.repeat(64) : emptyAttachmentsHash,
        status: 'active',
        confirmedBy: 'local-user',
      },
    });
    const report = await prisma.weeklyReport.update({
      where: { id: reportId },
      data: {
        status: 'confirmed',
        currentVersionId: versionId,
        confirmedVersionId: versionId,
        currentConfirmationId: confirmationId,
        version: { increment: 1 },
      },
    });
    return {
      suffix,
      reportId,
      versionId,
      confirmationId,
      templateId,
      robotConnectionId,
      reportVersion: report.version,
    };
  }

  async function seedIdempotency(suffix: string, label: string): Promise<string> {
    const id = `delivery-idempotency-${suffix}-${label}`;
    await prisma.idempotencyRecord.create({
      data: {
        id,
        actorId: 'local-user',
        route: `/test/${label}`,
        idempotencyKey: `delivery-${suffix}-${label}`,
        requestHash: '9'.repeat(64),
      },
    });
    return id;
  }

  function context(idempotencyRecordId: string) {
    return {
      correlationId: `correlation-${idempotencyRecordId}`,
      sessionId: 'delivery-session',
      idempotencyRecordId,
    };
  }

  async function execute(handler: WeeklyReportDeliveryHandler, intentId: string) {
    return handler.execute({
      jobId: `job-for-${intentId}`,
      payloadRef: intentId,
      isCancellationRequested: () => Promise.resolve(false),
      reportProgress: () => Promise.resolve(),
    });
  }
});
