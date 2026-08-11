import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { DingTalkLogClient } from '../src/modules/dingtalk/dingtalk-log.client.js';
import type { DingTalkRobotClient } from '../src/modules/dingtalk/dingtalk-robot.client.js';
import type { DingTalkDesktopClient } from '../src/modules/dingtalk/dingtalk-desktop.client.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import type { JobHandler } from '../src/modules/jobs/job-registry.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WeeklyReportDeliveryHandler } from '../src/modules/weekly-reports/weekly-report-delivery.handler.js';
import { businessDateAt } from '../src/modules/weekly-reports/weekly-report-delivery-date.js';
import { WeeklyReportDeliveryRecoveryService } from '../src/modules/weekly-reports/weekly-report-delivery-recovery.service.js';
import { WeeklyReportDeliveryService } from '../src/modules/weekly-reports/weekly-report-delivery.service.js';
import { WeeklyReportNotificationLedgerService } from '../src/modules/weekly-reports/weekly-report-notification-ledger.service.js';
import { WeeklyReportNotificationHandler } from '../src/modules/weekly-reports/weekly-report-notification.handler.js';
import { WeeklyReportNotificationService } from '../src/modules/weekly-reports/weekly-report-notification.service.js';

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

  it('submits all six fields through the signed-in DingTalk desktop client without API credentials', async () => {
    const fixture = await seedConfirmedReport({ desktop: true });
    const desktopSubmit = vi.fn().mockResolvedValue({
      success: true,
      status: 'succeeded',
      runId: 'desktop-run-1001',
      receipt: 'desktop:desktop-run-1001',
      observedFields: [...weeklyFields],
    });
    const createReport = vi.fn();
    const runtime = createRuntime(createReport, vi.fn(), undefined, desktopSubmit);
    const idempotency = await seedIdempotency(fixture.suffix, 'desktop-submit');

    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(idempotency),
    );
    const result = await execute(runtime.handler, requested.intent.id);

    expect(result).toMatchObject({
      status: 'succeeded',
      externalId: 'desktop:desktop-run-1001',
    });
    expect(createReport).not.toHaveBeenCalled();
    expect(desktopSubmit).toHaveBeenCalledOnce();
    const desktopCall = desktopSubmit.mock.calls[0] as unknown as Parameters<
      DingTalkDesktopClient['submit']
    >;
    expect(desktopCall[0]).toMatchObject({
      organizationName: 'Example Technology Co., Ltd.',
      templateName: 'R&D Weekly Report',
      recipientGroupName: 'R&D Center',
      timeoutSeconds: 45,
    });
    expect(desktopCall[1].reportDate).toBe(businessDateAt(new Date(), 'Asia/Shanghai'));
    expect(desktopCall[1].reportDate).not.toBe('2026-07-18');
    expect(Object.keys(desktopCall[1])).toEqual([...weeklyFields]);
    expect(
      [
        desktopCall[1].reportDate,
        desktopCall[1].recentGoals,
        desktopCall[1].weeklyWork,
        desktopCall[1].nextWeekPlans,
        desktopCall[1].problems,
        desktopCall[1].other,
      ].every((value) => value.length > 0),
    ).toBe(true);
    expect(
      await prisma.deliveryIntent.findUniqueOrThrow({ where: { id: requested.intent.id } }),
    ).toMatchObject({
      status: 'succeeded',
      externalId: 'desktop:desktop-run-1001',
      providerRequestId: 'desktop-run-1001',
      attemptCount: 1,
    });
    expect(
      await prisma.weeklyReport.findUniqueOrThrow({ where: { id: fixture.reportId } }),
    ).toMatchObject({ logDeliveryState: 'submitted' });
  });

  it('rejects an empty required field before opening DingTalk', async () => {
    const fixture = await seedConfirmedReport({ desktop: true, emptyWeeklyWork: true });
    const desktopSubmit = vi.fn();
    const runtime = createRuntime(vi.fn(), vi.fn(), undefined, desktopSubmit);
    const idempotency = await seedIdempotency(fixture.suffix, 'desktop-empty-required-field');

    await expect(
      runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
        },
        context(idempotency),
      ),
    ).rejects.toMatchObject({
      code: 'WEEKLY_REPORT_REQUIRED_FIELDS_EMPTY',
      options: { details: { missingFields: ['weeklyWork'] } },
    });
    expect(desktopSubmit).not.toHaveBeenCalled();
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(0);
  });

  it('rejects a desktop delivery when the frozen recipient differs from the configured default group', async () => {
    const fixture = await seedConfirmedReport({
      desktop: true,
      desktopRecipientGroupName: 'Another R&D Group',
    });
    const desktopSubmit = vi.fn();
    const runtime = createRuntime(vi.fn(), vi.fn(), undefined, desktopSubmit);
    const idempotency = await seedIdempotency(fixture.suffix, 'desktop-recipient-mismatch');

    await expect(
      runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
        },
        context(idempotency),
      ),
    ).rejects.toMatchObject({ code: 'DINGTALK_DESKTOP_RECIPIENT_SCOPE_MISMATCH' });
    expect(desktopSubmit).not.toHaveBeenCalled();
  });

  it('revalidates the desktop capability snapshot immediately before the scheduled external call', async () => {
    const fixture = await seedConfirmedReport({ desktop: true });
    const desktopSubmit = vi.fn();
    const runtime = createRuntime(vi.fn(), vi.fn(), undefined, desktopSubmit);
    const idempotency = await seedIdempotency(fixture.suffix, 'desktop-capability-changed');
    const requested = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(idempotency),
    );
    await prisma.integrationConnection.update({
      where: { id: fixture.logConnectionId },
      data: { status: 'unknown', capabilitiesJson: '{}' },
    });

    await expect(execute(runtime.handler, requested.intent.id)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'DINGTALK_LOG_CAPABILITY_CHANGED',
    });
    expect(desktopSubmit).not.toHaveBeenCalled();
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
        messageFacts: JSON.parse(notificationFact.messageFactsJson) as Record<string, unknown>,
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
      messageFacts: JSON.parse(notificationFact.messageFactsJson) as Record<string, unknown>,
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

  it('无需正式日志成功事实即可把当前周报作为测试消息发送到健康群机器人', async () => {
    const fixture = await seedConfirmedReport();
    const sendText = vi.fn().mockResolvedValue({
      requestId: 'test-report-request',
      timestamp: 1,
      providerCallCount: 1,
      retryDelaysMs: [],
    });
    const runtime = createRuntime(vi.fn(), sendText);
    const notifyRecord = await seedIdempotency(fixture.suffix, 'test-report-notify');

    const queued = await runtime.notifications.notifyTestReport(
      fixture.reportId,
      {
        versionId: fixture.versionId,
        robotConnectionId: fixture.robotConnectionId,
        reportVersion: fixture.reportVersion,
        confirmSendTestReport: true,
      },
      context(notifyRecord),
    );

    expect(queued).toMatchObject({ disposition: 'created' });
    expect(await execute(runtime.notificationHandler, queued.notification.id)).toMatchObject({
      status: 'succeeded',
    });
    const sent = sendText.mock.calls[0]![0] as Parameters<DingTalkRobotClient['sendText']>[0];
    expect(sent.text).toContain('【测试消息】Auto Work 周报流程验证');
    expect(sent.text).toContain('仅正式日志可见的完整工作正文');
    expect(sent.text).toContain('不会创建钉钉正式日志');
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(0);
  });

  it('明确的正式日志失败可生成去重失败提醒，独立通知作业只发送安全短摘要', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockRejectedValue(
      new DomainError('DINGTALK_LOG_PERMISSION_DENIED', 'Authorization: secret-value 权限不足', {
        httpStatus: 403,
      }),
    );
    const sendText = vi.fn().mockResolvedValue({
      requestId: 'failure-reminder-request',
      timestamp: 1,
      providerCallCount: 1,
      retryDelaysMs: [],
    });
    const runtime = createRuntime(createReport, sendText);
    const submitRecord = await seedIdempotency(fixture.suffix, 'failure-reminder-submit');
    const log = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitRecord),
    );
    await execute(runtime.handler, log.intent.id);
    const report = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    const notifyRecord = await seedIdempotency(fixture.suffix, 'failure-reminder-notify');
    const queued = await runtime.notifications.notifyFailure(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        failedDeliveryIntentId: log.intent.id,
        reportVersion: report.version,
      },
      context(notifyRecord),
    );
    expect(queued).toMatchObject({ disposition: 'created' });
    expect(await execute(runtime.notificationHandler, queued.notification.id)).toMatchObject({
      status: 'succeeded',
    });

    const sent = sendText.mock.calls[0]![0] as Parameters<DingTalkRobotClient['sendText']>[0];
    expect(sent.text).toContain('周报交付失败提醒');
    expect(sent.text).toContain('失败阶段：钉钉正式日志提交');
    expect(sent.text).toContain('[REDACTED] 权限不足');
    expect(sent.text).not.toContain('仅正式日志可见的完整工作正文');
    expect(sent.text).not.toContain('secret-value');
    expect(await runtime.notifications.list(fixture.reportId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: queued.notification.id,
          notificationType: 'submission_failure',
          status: 'succeeded',
          providerRequestId: 'failure-reminder-request',
        }),
      ]),
    );

    const duplicateRecord = await seedIdempotency(fixture.suffix, 'failure-reminder-duplicate');
    const duplicate = await runtime.notifications.notifyFailure(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        failedDeliveryIntentId: log.intent.id,
        reportVersion: report.version,
      },
      context(duplicateRecord),
    );
    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      jobId: queued.jobId,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('失败提醒网络超时进入 unknown，通知作业和重复执行都不会盲目重放', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi
      .fn()
      .mockRejectedValue(new DomainError('DINGTALK_LOG_REJECTED', '正式日志明确失败'));
    const sendText = vi.fn().mockRejectedValue(
      new DomainError('EXTERNAL_REQUEST_TIMEOUT', '机器人请求超时', {
        httpStatus: 504,
        retryable: true,
      }),
    );
    const runtime = createRuntime(createReport, sendText);
    const submitRecord = await seedIdempotency(fixture.suffix, 'notification-unknown-submit');
    const log = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
      },
      context(submitRecord),
    );
    await execute(runtime.handler, log.intent.id);
    const report = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    const notifyRecord = await seedIdempotency(fixture.suffix, 'notification-unknown-notify');
    const queued = await runtime.notifications.notifyFailure(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        failedDeliveryIntentId: log.intent.id,
        reportVersion: report.version,
      },
      context(notifyRecord),
    );
    await expect(
      execute(runtime.notificationHandler, queued.notification.id),
    ).rejects.toMatchObject({ code: 'DINGTALK_NOTIFICATION_RESULT_UNKNOWN' });
    expect(
      await prisma.robotNotification.findUniqueOrThrow({
        where: { id: queued.notification.id },
      }),
    ).toMatchObject({ status: 'unknown', lastErrorCode: 'EXTERNAL_REQUEST_TIMEOUT' });
    await expect(
      execute(runtime.notificationHandler, queued.notification.id),
    ).rejects.toMatchObject({ code: 'ROBOT_NOTIFICATION_NOT_EXECUTABLE' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('严重风险提醒只采用当前版本已配置 warning，并按状态版本去重和静默合并', async () => {
    const riskWarnings = [
      {
        code: 'SOURCE_UNAVAILABLE',
        message: 'Jira 来源当前不可用，请核对同步状态',
        sourceRefs: [{ type: 'task', id: 'task-risk-1' }],
        blocking: false,
      },
      {
        code: 'SOURCE_STALE',
        message: 'Git 证据缓存已经过期，请刷新后确认',
        sourceRefs: [{ type: 'evidence', id: 'evidence-risk-2' }],
        blocking: false,
      },
      {
        code: 'UNCONFIRMED_EVIDENCE',
        message: '这条未配置规则不得发送',
        sourceRefs: [],
        blocking: false,
      },
    ];
    const fixture = await seedConfirmedReport({
      warnings: riskWarnings,
      severeRiskCodes: ['SOURCE_UNAVAILABLE', 'SOURCE_STALE'],
      quietWindowMinutes: 30,
    });
    const sendText = vi.fn().mockResolvedValue({
      requestId: 'risk-notification-request',
      timestamp: Date.now(),
      providerCallCount: 1,
      retryDelaysMs: [],
    });
    const runtime = createRuntime(vi.fn(), sendText);
    const warningIds = riskWarnings.slice(0, 2).map((warning) => requestHash(warning));
    const firstRecord = await seedIdempotency(fixture.suffix, 'risk-notification-first');
    const first = await runtime.notifications.notifyRisk(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        versionId: fixture.versionId,
        warningIds,
        reportVersion: fixture.reportVersion,
      },
      context(firstRecord),
    );
    expect(first.disposition).toBe('created');
    await execute(runtime.notificationHandler, first.notification.id);

    expect(sendText).toHaveBeenCalledOnce();
    const sent = sendText.mock.calls[0]![0] as Parameters<DingTalkRobotClient['sendText']>[0];
    expect(sent.text).toContain('来源不可用（SOURCE_UNAVAILABLE，选中 1 项）');
    expect(sent.text).toContain('来源数据过期（SOURCE_STALE，选中 1 项）');
    expect(sent.text).not.toContain('Jira 来源当前不可用');
    expect(sent.text).not.toContain('Git 证据缓存已经过期');
    expect(sent.text).not.toContain('这条未配置规则不得发送');
    expect(sent.text).not.toContain('仅正式日志可见的完整工作正文');

    const duplicateRecord = await seedIdempotency(fixture.suffix, 'risk-notification-duplicate');
    const duplicate = await runtime.notifications.notifyRisk(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        versionId: fixture.versionId,
        warningIds: [...warningIds].reverse(),
        reportVersion: fixture.reportVersion,
      },
      context(duplicateRecord),
    );
    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      notification: { id: first.notification.id },
    });

    const baseVersion = await prisma.weeklyReportVersion.findUniqueOrThrow({
      where: { id: fixture.versionId },
    });
    const nextVersionId = `${fixture.versionId}-risk-next`;
    await prisma.weeklyReportVersion.create({
      data: {
        id: nextVersionId,
        reportId: baseVersion.reportId,
        versionNo: 2,
        origin: 'manual',
        parentVersionId: baseVersion.id,
        reportDateText: baseVersion.reportDateText,
        recentGoalsText: baseVersion.recentGoalsText,
        weeklyWorkText: baseVersion.weeklyWorkText,
        nextWeekPlansText: baseVersion.nextWeekPlansText,
        problemsText: baseVersion.problemsText,
        otherText: baseVersion.otherText,
        fieldsJson: baseVersion.fieldsJson,
        warningsJson: baseVersion.warningsJson,
        attachmentsJson: baseVersion.attachmentsJson,
        recipientScopeJson: baseVersion.recipientScopeJson,
        templateMappingVersionId: baseVersion.templateMappingVersionId,
        scheduleAt: baseVersion.scheduleAt,
        sourceSnapshotId: baseVersion.sourceSnapshotId,
        contentHash: '7'.repeat(64),
        changeSummaryJson: JSON.stringify({ kind: 'risk-quiet-window-test' }),
        createdBy: 'local-user',
      },
    });
    const nextReport = await prisma.weeklyReport.update({
      where: { id: fixture.reportId },
      data: { currentVersionId: nextVersionId, version: { increment: 1 } },
    });
    const coalescedRecord = await seedIdempotency(fixture.suffix, 'risk-notification-coalesced');
    const coalesced = await runtime.notifications.notifyRisk(
      fixture.reportId,
      {
        robotConnectionId: fixture.robotConnectionId,
        versionId: nextVersionId,
        warningIds,
        reportVersion: nextReport.version,
      },
      context(coalescedRecord),
    );
    expect(coalesced).toMatchObject({
      disposition: 'coalesced',
      notification: { id: first.notification.id, coalescedCount: 1 },
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it('严重风险提醒拒绝伪造 warning ID 和未配置规则', async () => {
    const riskWarnings = [
      { code: 'SOURCE_UNAVAILABLE', message: '允许的风险', sourceRefs: [], blocking: false },
      { code: 'SOURCE_STALE', message: '未配置的风险', sourceRefs: [], blocking: false },
    ];
    const fixture = await seedConfirmedReport({
      warnings: riskWarnings,
      severeRiskCodes: ['SOURCE_UNAVAILABLE'],
    });
    const runtime = createRuntime(vi.fn(), vi.fn());
    const forgedRecord = await seedIdempotency(fixture.suffix, 'risk-forged-warning');
    await expect(
      runtime.notifications.notifyRisk(
        fixture.reportId,
        {
          robotConnectionId: fixture.robotConnectionId,
          versionId: fixture.versionId,
          warningIds: ['f'.repeat(64)],
          reportVersion: fixture.reportVersion,
        },
        context(forgedRecord),
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_RISK_WARNING_INVALID' });

    const unconfiguredRecord = await seedIdempotency(fixture.suffix, 'risk-unconfigured-warning');
    await expect(
      runtime.notifications.notifyRisk(
        fixture.reportId,
        {
          robotConnectionId: fixture.robotConnectionId,
          versionId: fixture.versionId,
          warningIds: [requestHash(riskWarnings[1]!)],
          reportVersion: fixture.reportVersion,
        },
        context(unconfiguredRecord),
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_RISK_RULE_NOT_CONFIGURED' });
    expect(await prisma.robotNotification.count({ where: { reportId: fixture.reportId } })).toBe(0);
  });

  it('超时结果进入 unknown 且重复请求不会盲目创建第二次外部调用', async () => {
    const fixture = await seedConfirmedReport();
    const createReport = vi.fn().mockRejectedValue(
      new DomainError('DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN', '桌面提交结果未知', {
        httpStatus: 503,
        retryable: false,
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
    ).toMatchObject({
      status: 'unknown',
      lastErrorCode: 'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN',
    });

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
    const unknownReport = await prisma.weeklyReport.findUniqueOrThrow({
      where: { id: fixture.reportId },
    });
    const failureReminderRecord = await seedIdempotency(fixture.suffix, 'unknown-failure-reminder');
    await expect(
      runtime.notifications.notifyFailure(
        fixture.reportId,
        {
          robotConnectionId: fixture.robotConnectionId,
          failedDeliveryIntentId: requested.intent.id,
          reportVersion: unknownReport.version,
        },
        context(failureReminderRecord),
      ),
    ).rejects.toMatchObject({ code: 'DINGTALK_LOG_FAILURE_FACT_REQUIRED' });
  });

  it('历史 unknown 属于旧确认时仍阻止新确认创建第二份正式日志', async () => {
    const fixture = await seedConfirmedReport();
    const oldConfirmationId = `delivery-old-confirmation-${fixture.suffix}`;
    const oldIdempotency = await seedIdempotency(fixture.suffix, 'old-unknown-intent');
    await prisma.weeklyReportConfirmation.create({
      data: {
        id: oldConfirmationId,
        reportId: fixture.reportId,
        versionId: fixture.versionId,
        reportAggregateVersion: 1,
        contentHash: '8'.repeat(64),
        templateMappingVersionId: (
          await prisma.weeklyReport.findUniqueOrThrow({ where: { id: fixture.reportId } })
        ).templateMappingVersionId!,
        warningAcknowledgementsJson: '[]',
        recipientScopeHash: recipientHash,
        attachmentsHash: emptyAttachmentsHash,
        status: 'invalidated',
        confirmedBy: 'local-user',
        invalidatedAt: new Date(),
        invalidationReason: '测试历史未知交付',
      },
    });
    await prisma.deliveryIntent.create({
      data: {
        id: `delivery-old-unknown-${fixture.suffix}`,
        reportId: fixture.reportId,
        confirmationId: oldConfirmationId,
        confirmedVersionId: fixture.versionId,
        connectionId: fixture.logConnectionId,
        channel: 'dingtalk_log',
        idempotencyRecordId: oldIdempotency,
        requestHash: '7'.repeat(64),
        status: 'unknown',
        lastErrorCode: 'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN',
        lastErrorSummary: '旧提交结果未知',
        recoveryStatus: 'pending',
      },
    });
    const runtime = createRuntime(vi.fn(), vi.fn());
    const nextIdempotency = await seedIdempotency(fixture.suffix, 'blocked-by-old-unknown');

    await expect(
      runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
        },
        context(nextIdempotency),
      ),
    ).rejects.toMatchObject({
      code: 'DINGTALK_DELIVERY_REVIEW_REQUIRED',
      options: { suggestedAction: 'manual_review' },
    });
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(1);
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

  it('未来预约必须显式批准准确时间，确认失效后在外部调用前自动取消', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1_000);
    const fixture = await seedConfirmedReport({ scheduleAt: scheduledAt });
    const createReport = vi.fn().mockResolvedValue({
      reportId: 'scheduled-report-must-not-be-created',
      requestId: 'scheduled-provider-request',
    });
    const runtime = createRuntime(createReport, vi.fn());

    const missingApproval = await seedIdempotency(fixture.suffix, 'schedule-missing-approval');
    await expect(
      runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
        },
        context(missingApproval),
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_SCHEDULE_APPROVAL_REQUIRED' });
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(0);

    const mismatchedApproval = await seedIdempotency(
      fixture.suffix,
      'schedule-mismatched-approval',
    );
    await expect(
      runtime.service.submitLog(
        fixture.reportId,
        {
          confirmationId: fixture.confirmationId,
          confirmedVersionId: fixture.versionId,
          recipientScopeHash: recipientHash,
          reportVersion: fixture.reportVersion,
          scheduledApproval: {
            scheduledAt: new Date(scheduledAt.getTime() + 1_000).toISOString(),
            confirmationPhrase: '我确认在计划时间自动提交钉钉正式日志',
          },
        },
        context(mismatchedApproval),
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REPORT_SCHEDULE_APPROVAL_REQUIRED' });
    expect(await prisma.deliveryIntent.count({ where: { reportId: fixture.reportId } })).toBe(0);

    const approvedRequest = await seedIdempotency(fixture.suffix, 'schedule-approved');
    const approved = await runtime.service.submitLog(
      fixture.reportId,
      {
        confirmationId: fixture.confirmationId,
        confirmedVersionId: fixture.versionId,
        recipientScopeHash: recipientHash,
        reportVersion: fixture.reportVersion,
        scheduledApproval: {
          scheduledAt: scheduledAt.toISOString(),
          confirmationPhrase: '我确认在计划时间自动提交钉钉正式日志',
        },
      },
      context(approvedRequest),
    );
    expect(approved).toMatchObject({
      replayed: false,
      intent: {
        status: 'pending',
        scheduledFor: scheduledAt.toISOString(),
      },
    });
    expect(approved.intent.scheduleApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(approved.intent.scheduleApprovalHash).toMatch(/^[a-f0-9]{64}$/u);
    const queuedJob = await prisma.job.findFirstOrThrow({
      where: { payloadRef: approved.intent.id },
    });
    expect(queuedJob.scheduledAt).toEqual(scheduledAt);
    expect(createReport).not.toHaveBeenCalled();

    // 模拟预约等待期间正文被编辑：旧确认一旦失效，执行器必须在创建尝试和外部调用前止损。
    await prisma.weeklyReportConfirmation.update({
      where: { id: fixture.confirmationId },
      data: {
        status: 'invalidated',
        invalidatedAt: new Date(),
        invalidationReason: '预约等待期间正文已编辑',
      },
    });
    expect(await execute(runtime.handler, approved.intent.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(createReport).not.toHaveBeenCalled();
    expect(await prisma.deliveryAttempt.count({ where: { intentId: approved.intent.id } })).toBe(0);
    expect(
      await prisma.deliveryIntent.findUniqueOrThrow({ where: { id: approved.intent.id } }),
    ).toMatchObject({
      status: 'cancelled',
      cancellationReason: '执行前发现当前确认或冻结版本已变化',
      lastErrorCode: 'SCHEDULED_DELIVERY_CONFIRMATION_INVALIDATED',
    });
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
    desktopSubmit: ReturnType<typeof vi.fn> = vi.fn(),
  ) {
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const audit = new AuditService(prismaService);
    const security = {
      sessionHash: () => 'delivery-session-hash',
    } as unknown as LocalSecurityService;
    const notificationLedger = new WeeklyReportNotificationLedgerService(prismaService);
    const desktopClient = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      submit: desktopSubmit,
    } as unknown as DingTalkDesktopClient;
    const service = new WeeklyReportDeliveryService(
      prismaService,
      sessions,
      audit,
      security,
      notificationLedger,
      desktopClient,
    );
    const notifications = new WeeklyReportNotificationService(
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
      desktopClient,
      robotClient,
      vault,
    );
    handler.onModuleInit();
    const notificationHandler = new WeeklyReportNotificationHandler(
      registry,
      prismaService,
      robotClient,
      vault,
    );
    notificationHandler.onModuleInit();
    const recovery = new WeeklyReportDeliveryRecoveryService(
      prismaService,
      sessions,
      audit,
      security,
      logClient,
      vault,
    );
    expect(registry.get('weekly-report.delivery')).toBe(handler);
    return {
      service,
      handler,
      recovery,
      notificationLedger,
      notifications,
      notificationHandler,
    };
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
    desktop?: boolean;
    desktopRecipientGroupName?: string;
    emptyWeeklyWork?: boolean;
    warnings?: Array<Record<string, unknown>>;
    severeRiskCodes?: string[];
    quietWindowMinutes?: number;
    scheduleAt?: Date;
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
    const desktopRecipientGroupName = options?.desktopRecipientGroupName ?? 'R&D Center';

    await prisma.integrationConnection.createMany({
      data: [
        {
          id: logConnectionId,
          type: options?.desktop ? 'dingtalk_desktop' : 'dingtalk_log',
          name: `正式日志 ${suffix}`,
          baseUrl: options?.desktop ? null : 'https://oapi.dingtalk.com/',
          credentialRef: options?.desktop ? null : `vault:log:${suffix}`,
          enabled: true,
          status: 'healthy',
          capabilitiesJson: JSON.stringify({ templateDiscovery: { snapshotHash: capabilityHash } }),
          configJson: JSON.stringify(
            options?.desktop
              ? {
                  organizationName: 'Example Technology Co., Ltd.',
                  templateName: 'R&D Weekly Report',
                  recipientGroupName: 'R&D Center',
                  timeoutSeconds: 45,
                }
              : { appKey: 'app-key', operatorUserId: 'operator-user' },
          ),
        },
        {
          id: robotConnectionId,
          type: 'dingtalk_robot',
          name: `群通知 ${suffix}`,
          credentialRef: `vault:robot:${suffix}`,
          enabled: true,
          status: 'healthy',
          capabilitiesJson: JSON.stringify({ fullReportForbidden: true }),
          configJson: JSON.stringify({
            robotName: '研发群机器人',
            groupId: 'group-1',
            quietWindowMinutes: options?.quietWindowMinutes ?? 30,
            severeRiskCodes: options?.severeRiskCodes ?? [],
          }),
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
        subjectType: options?.desktop ? 'group' : 'user',
        externalId: options?.desktop
          ? `desktop-group:${requestHash(desktopRecipientGroupName).slice(0, 24)}`
          : 'recipient-user',
        displayName: options?.desktop ? desktopRecipientGroupName : '接收人',
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
        subjectType: options?.desktop ? 'group' : 'user',
        externalId: options?.desktop
          ? `desktop-group:${requestHash(desktopRecipientGroupName).slice(0, 24)}`
          : 'recipient-user',
        displayName: options?.desktop ? desktopRecipientGroupName : '接收人',
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
        weeklyWorkText: options?.emptyWeeklyWork ? '' : '仅正式日志可见的完整工作正文',
        nextWeekPlansText: '继续交付',
        problemsText: '暂无',
        otherText: '无',
        fieldsJson: '{}',
        warningsJson: JSON.stringify(options?.warnings ?? []),
        attachmentsJson: JSON.stringify(attachments),
        recipientScopeJson: JSON.stringify({ recipients }),
        templateMappingVersionId: mappingVersionId,
        ...(options?.scheduleAt ? { scheduleAt: options.scheduleAt } : {}),
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
      logConnectionId,
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

  async function execute(handler: JobHandler, intentId: string) {
    return handler.execute({
      jobId: `job-for-${intentId}`,
      payloadRef: intentId,
      isCancellationRequested: () => Promise.resolve(false),
      reportProgress: () => Promise.resolve(),
    });
  }
});
