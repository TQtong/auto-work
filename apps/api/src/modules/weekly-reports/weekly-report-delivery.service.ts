import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { WeeklyReportNotificationLedgerService } from './weekly-report-notification-ledger.service.js';
import {
  buildWeeklyReportRobotNotification,
  projectNamesFromTaskFacts,
} from './weekly-report-robot-notification.js';
import type {
  NotifyWeeklyReportGroupInput,
  SubmitWeeklyReportLogInput,
} from './weekly-report.schemas.js';

interface DeliveryAuditContext {
  correlationId: string;
  sessionId: string;
  idempotencyRecordId: string;
}

@Injectable()
export class WeeklyReportDeliveryService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly notificationLedger: WeeklyReportNotificationLedgerService,
  ) {}

  public async submitLog(
    reportId: string,
    input: SubmitWeeklyReportLogInput,
    context: DeliveryAuditContext,
  ) {
    const facts = await this.loadConfirmedFacts(reportId, input.confirmationId);
    const connection = facts.confirmation.templateMappingVersion.mapping.connection;
    const existing = await this.prisma.deliveryIntent.findUnique({
      where: {
        reportId_confirmationId_channel_connectionId: {
          reportId,
          confirmationId: input.confirmationId,
          channel: 'dingtalk_log',
          connectionId: connection.id,
        },
      },
    });
    if (existing) return this.replayExisting(existing, context.idempotencyRecordId);

    this.assertSubmissionFacts(facts, input, connection);
    const scope = this.parseObject(facts.confirmedVersion.recipientScopeJson);
    const recipients = Array.isArray(scope.recipients) ? scope.recipients : [];
    await this.assertRecipientFacts(connection.id, recipients);
    const attachmentFacts = this.parseArray(facts.confirmedVersion.attachmentsJson);
    if (attachmentFacts.length > 0) {
      throw new DomainError(
        'DINGTALK_LOG_ATTACHMENTS_UNSUPPORTED',
        '当前已批准的钉钉正式日志适配器不支持可靠附件上传，请移除附件后重新确认，或使用降级导出',
        { httpStatus: 422, suggestedAction: 'reconfirm' },
      );
    }
    const targetSummary = {
      connectionId: connection.id,
      connectionName: connection.name,
      templateId: facts.confirmation.templateMappingVersion.templateId,
      templateName: facts.confirmation.templateMappingVersion.templateName,
      userRecipientCount: recipients.filter(
        (value) => this.parseObject(value).subjectType === 'user',
      ).length,
      groupRecipientCount: recipients.filter(
        (value) => this.parseObject(value).subjectType === 'group',
      ).length,
      groupDeliveryMode: 'template_defaults_only',
      attachmentCount: 0,
    };
    return this.createIntent({
      reportId,
      confirmationId: input.confirmationId,
      confirmedVersionId: input.confirmedVersionId,
      connectionId: connection.id,
      channel: 'dingtalk_log',
      reportVersion: input.reportVersion,
      requestHash: requestHash({ reportId, ...input, targetSummary }),
      targetSummary,
      jobType: 'weekly-report.delivery',
      deliveryStateField: 'logDeliveryState',
      deliveryState: 'submitting',
      context,
    });
  }

  public async notifyGroup(
    reportId: string,
    input: NotifyWeeklyReportGroupInput,
    context: DeliveryAuditContext,
  ) {
    const facts = await this.loadConfirmedFacts(reportId, input.confirmationId);
    const robot = await this.prisma.integrationConnection.findUnique({
      where: { id: input.robotConnectionId },
    });
    if (!robot || robot.type !== 'dingtalk_robot') {
      throw new DomainError('DINGTALK_ROBOT_CONNECTION_NOT_FOUND', '钉钉机器人连接不存在', {
        httpStatus: 404,
      });
    }
    const existing = await this.prisma.deliveryIntent.findUnique({
      where: {
        reportId_confirmationId_channel_connectionId: {
          reportId,
          confirmationId: input.confirmationId,
          channel: 'dingtalk_robot',
          connectionId: robot.id,
        },
      },
    });
    if (existing) return this.replayExisting(existing, context.idempotencyRecordId);

    if (facts.report.version !== input.reportVersion) this.throwVersionConflict();
    if (facts.report.logDeliveryState !== 'submitted') {
      throw new DomainError(
        'DINGTALK_LOG_NOT_SUBMITTED',
        '只有正式日志已经明确成功后才能发送群摘要',
        { httpStatus: 409 },
      );
    }
    if (!robot.enabled || robot.status !== 'healthy' || !robot.credentialRef) {
      throw new DomainError(
        'DINGTALK_ROBOT_NOT_HEALTHY',
        '钉钉机器人必须启用、测试健康且已有当前凭证',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    const logIntent = await this.prisma.deliveryIntent.findFirst({
      where: {
        reportId,
        confirmationId: input.confirmationId,
        channel: 'dingtalk_log',
        status: 'succeeded',
      },
      orderBy: { completedAt: 'desc' },
    });
    if (!logIntent?.externalId) {
      throw new DomainError(
        'DINGTALK_LOG_SUCCESS_FACT_MISSING',
        '正式日志成功状态缺少可核验的外部日志 ID，不能发送成功摘要',
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    const robotConfig = this.parseObject(robot.configJson);
    const message = buildWeeklyReportRobotNotification({
      type: 'submission_success',
      periodStart: facts.report.periodStart,
      periodEnd: facts.report.periodEnd,
      reportDate: facts.report.reportDate,
      formalLogId: logIntent.externalId,
      projectNames: projectNamesFromTaskFacts(facts.confirmedVersion.sourceSnapshot.taskFactsJson),
    });
    const quietWindowMinutes =
      typeof robotConfig.quietWindowMinutes === 'number' &&
      Number.isInteger(robotConfig.quietWindowMinutes) &&
      robotConfig.quietWindowMinutes >= 0 &&
      robotConfig.quietWindowMinutes <= 1_440
        ? robotConfig.quietWindowMinutes
        : 30;
    const targetSummary = {
      connectionId: robot.id,
      robotName: robotConfig.robotName ?? robot.name,
      groupId: robotConfig.groupId ?? null,
      notificationType: input.notificationType,
      formalLogIntentId: logIntent.id,
      formalLogExternalId: logIntent.externalId,
      fullReportForbidden: true,
      localhostLinkForbidden: true,
      notificationStateVersion: logIntent.version,
      notificationContentHash: requestHash({ notificationType: input.notificationType, message }),
      quietWindowMinutes,
    };
    return this.createIntent({
      reportId,
      confirmationId: input.confirmationId,
      confirmedVersionId: facts.confirmedVersion.id,
      connectionId: robot.id,
      channel: 'dingtalk_robot',
      reportVersion: input.reportVersion,
      requestHash: requestHash({ reportId, ...input, targetSummary }),
      targetSummary,
      jobType: 'weekly-report.delivery',
      deliveryStateField: 'robotDeliveryState',
      deliveryState: 'not_started',
      robotNotification: {
        notificationType: input.notificationType,
        businessObjectKey: `weekly-report:${reportId}`,
        stateVersion: logIntent.version,
        contentHash: requestHash({ notificationType: input.notificationType, message }),
        quietWindowMinutes,
        messageFacts: {
          type: 'submission_success',
          periodStart: facts.report.periodStart,
          periodEnd: facts.report.periodEnd,
          reportDate: facts.report.reportDate,
          formalLogId: logIntent.externalId,
          projectNames: projectNamesFromTaskFacts(
            facts.confirmedVersion.sourceSnapshot.taskFactsJson,
          ),
        },
      },
      context,
    });
  }

  public async list(reportId: string) {
    await this.requireOwnedReport(reportId);
    const intents = await this.prisma.deliveryIntent.findMany({
      where: { reportId },
      include: {
        attempts: { orderBy: { attemptNo: 'desc' } },
        recoveryChecks: { orderBy: { sequenceNo: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return intents.map((intent) => this.serializeIntent(intent));
  }

  private async createIntent(input: {
    reportId: string;
    confirmationId: string;
    confirmedVersionId: string;
    connectionId: string;
    channel: 'dingtalk_log' | 'dingtalk_robot';
    reportVersion: number;
    requestHash: string;
    targetSummary: Record<string, unknown>;
    jobType: string;
    deliveryStateField: 'logDeliveryState' | 'robotDeliveryState';
    deliveryState: string;
    robotNotification?: {
      notificationType: 'submission_success';
      businessObjectKey: string;
      stateVersion: number;
      contentHash: string;
      quietWindowMinutes: number;
      messageFacts: Record<string, unknown>;
    };
    context: DeliveryAuditContext;
  }) {
    const intentId = newId();
    const jobId = newId();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const changed = await tx.weeklyReport.updateMany({
          where: {
            id: input.reportId,
            ownerProfileId: this.sessions.currentProfileId,
            version: input.reportVersion,
            currentConfirmationId: input.confirmationId,
            confirmedVersionId: input.confirmedVersionId,
            status: 'confirmed',
          },
          data: {
            [input.deliveryStateField]: input.deliveryState,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) this.throwVersionConflict();
        const intent = await tx.deliveryIntent.create({
          data: {
            id: intentId,
            reportId: input.reportId,
            confirmationId: input.confirmationId,
            confirmedVersionId: input.confirmedVersionId,
            connectionId: input.connectionId,
            channel: input.channel,
            idempotencyRecordId: input.context.idempotencyRecordId,
            requestHash: input.requestHash,
            targetSummaryJson: JSON.stringify(input.targetSummary),
            jobId,
          },
        });
        await tx.job.create({
          data: {
            id: jobId,
            type: input.jobType,
            payloadRef: intent.id,
            payloadSummary: JSON.stringify({
              reportId: input.reportId,
              intentId: intent.id,
              channel: input.channel,
              connectionId: input.connectionId,
            }),
            scheduledAt: new Date(),
            maxAttempts: 1,
            dedupeKey: `weekly-report.delivery:${intent.id}`,
          },
        });
        if (input.robotNotification) {
          const reservation = await this.notificationLedger.reserveInTransaction(tx, {
            reportId: input.reportId,
            connectionId: input.connectionId,
            deliveryIntentId: intent.id,
            notificationType: input.robotNotification.notificationType,
            businessObjectKey: input.robotNotification.businessObjectKey,
            stateVersion: input.robotNotification.stateVersion,
            contentHash: input.robotNotification.contentHash,
            messageFacts: input.robotNotification.messageFacts,
            quietWindowMinutes: input.robotNotification.quietWindowMinutes,
            scheduledFor: new Date(),
            jobId,
          });
          if (reservation.disposition !== 'created') {
            throw new DomainError(
              'ROBOT_NOTIFICATION_RESERVATION_CONFLICT',
              '机器人通知账本已存在不一致事实，当前交付不会继续排队',
              { httpStatus: 409, suggestedAction: 'manual_review' },
            );
          }
        }
        const response = { intent: this.serializeIntent(intent), jobId, replayed: false };
        await this.completeIdempotency(tx, input.context.idempotencyRecordId, response);
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: `weekly_report.delivery_${input.channel}_requested`,
          targetType: 'delivery_intent',
          targetId: intent.id,
          correlationId: input.context.correlationId,
          outcome: 'succeeded',
          after: {
            reportId: input.reportId,
            confirmationId: input.confirmationId,
            channel: input.channel,
            connectionId: input.connectionId,
            requestHash: input.requestHash,
          },
          clientSessionHash: this.security.sessionHash(input.context.sessionId),
        });
        return response;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.deliveryIntent.findUnique({
          where: {
            reportId_confirmationId_channel_connectionId: {
              reportId: input.reportId,
              confirmationId: input.confirmationId,
              channel: input.channel,
              connectionId: input.connectionId,
            },
          },
        });
        if (existing) return this.replayExisting(existing, input.context.idempotencyRecordId);
      }
      throw error;
    }
  }

  private async replayExisting(
    intent: {
      id: string;
      reportId: string;
      confirmationId: string;
      confirmedVersionId: string;
      connectionId: string;
      channel: string;
      status: string;
      jobId: string | null;
      externalId: string | null;
      externalUrl: string | null;
      attemptCount: number;
      lastErrorCode: string | null;
      lastErrorSummary: string | null;
      createdAt: Date;
      updatedAt: Date;
      version: number;
    },
    idempotencyRecordId: string,
  ) {
    const response = {
      intent: this.serializeIntent(intent),
      jobId: intent.jobId,
      replayed: true,
    };
    await this.prisma.$transaction((tx) =>
      this.completeIdempotency(tx, idempotencyRecordId, response),
    );
    return response;
  }

  private assertSubmissionFacts(
    facts: Awaited<ReturnType<WeeklyReportDeliveryService['loadConfirmedFacts']>>,
    input: SubmitWeeklyReportLogInput,
    connection: {
      enabled: boolean;
      status: string;
      credentialRef: string | null;
      capabilitiesJson: string;
    },
  ): void {
    if (facts.report.version !== input.reportVersion) this.throwVersionConflict();
    if (
      facts.report.status !== 'confirmed' ||
      facts.report.currentConfirmationId !== input.confirmationId ||
      facts.report.confirmedVersionId !== input.confirmedVersionId ||
      facts.confirmation.status !== 'active' ||
      facts.confirmation.versionId !== input.confirmedVersionId ||
      facts.confirmation.recipientScopeHash !== input.recipientScopeHash
    ) {
      throw new DomainError(
        'WEEKLY_REPORT_CONFIRMATION_NOT_SUBMITTABLE',
        '正式提交只接受当前有效确认冻结的版本、模板和接收范围',
        { httpStatus: 409, suggestedAction: 'reconfirm' },
      );
    }
    const mapping = facts.confirmation.templateMappingVersion;
    const discovery = this.parseObject(
      this.parseObject(connection.capabilitiesJson).templateDiscovery,
    );
    if (
      !connection.enabled ||
      connection.status !== 'healthy' ||
      !connection.credentialRef ||
      mapping.mapping.currentVersionId !== mapping.id ||
      mapping.expiresAt <= new Date() ||
      discovery.snapshotHash !== mapping.capabilitySnapshotHash
    ) {
      throw new DomainError(
        'DINGTALK_LOG_CAPABILITY_CHANGED',
        '钉钉日志连接、模板或能力快照已变化，请重新探测并确认周报',
        { httpStatus: 422, suggestedAction: 'reconfirm' },
      );
    }
  }

  private async assertRecipientFacts(connectionId: string, recipients: unknown[]): Promise<void> {
    if (recipients.length === 0) {
      throw new DomainError('DINGTALK_RECIPIENTS_REQUIRED', '正式提交至少需要一个有效接收对象', {
        httpStatus: 422,
      });
    }
    const submitted = recipients.map((value) => this.parseObject(value));
    const ids = submitted.map((value) =>
      typeof value.validationId === 'string' ? value.validationId : '',
    );
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new DomainError('DINGTALK_RECIPIENT_SCOPE_INVALID', '确认的接收范围结构无效或重复', {
        httpStatus: 422,
      });
    }
    const rows = await this.prisma.dingTalkRecipientValidation.findMany({
      where: {
        id: { in: ids },
        connectionId,
        available: true,
        expiresAt: { gt: new Date() },
      },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    if (
      rows.length !== ids.length ||
      submitted.some((value) => {
        const row = rowById.get(String(value.validationId));
        return (
          !row ||
          row.contentHash !== value.contentHash ||
          row.externalId !== value.externalId ||
          row.subjectType !== value.subjectType
        );
      })
    ) {
      throw new DomainError(
        'DINGTALK_RECIPIENT_FACTS_EXPIRED',
        '接收对象已过期、被移除或事实发生变化，请重新确认周报',
        { httpStatus: 422, suggestedAction: 'reconfirm' },
      );
    }
  }

  private async loadConfirmedFacts(reportId: string, confirmationId: string) {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: {
        confirmedVersion: { include: { sourceSnapshot: true } },
        currentConfirmation: {
          include: {
            templateMappingVersion: {
              include: { mapping: { include: { connection: true } } },
            },
          },
        },
      },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
    if (
      !report.confirmedVersion ||
      !report.currentConfirmation ||
      report.currentConfirmation.id !== confirmationId
    ) {
      throw new DomainError(
        'WEEKLY_REPORT_ACTIVE_CONFIRMATION_MISSING',
        '周报没有与请求一致的当前有效确认',
        { httpStatus: 409, suggestedAction: 'reconfirm' },
      );
    }
    return {
      report,
      confirmedVersion: report.confirmedVersion,
      confirmation: report.currentConfirmation,
    };
  }

  private async requireOwnedReport(reportId: string): Promise<void> {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus: 202,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private serializeIntent(intent: {
    id: string;
    reportId: string;
    confirmationId: string;
    confirmedVersionId: string;
    connectionId: string;
    channel: string;
    status: string;
    jobId: string | null;
    externalId: string | null;
    externalUrl: string | null;
    attemptCount: number;
    lastErrorCode: string | null;
    lastErrorSummary: string | null;
    recoveryStatus?: string;
    lastRecoveryAt?: Date | null;
    resolvedBy?: string | null;
    resolvedAt?: Date | null;
    resolutionReason?: string | null;
    createdAt: Date;
    updatedAt: Date;
    version?: number;
    attempts?: Array<{
      id: string;
      attemptNo: number;
      status: string;
      providerRequestId: string | null;
      externalId: string | null;
      externalUrl: string | null;
      providerErrorCode: string | null;
      retryAt: Date | null;
      startedAt: Date;
      completedAt: Date | null;
    }>;
    recoveryChecks?: Array<{
      id: string;
      sequenceNo: number;
      mode: string;
      outcome: string;
      queryWindowStart: Date | null;
      queryWindowEnd: Date | null;
      candidateCount: number;
      exactMatchCount: number;
      matchedExternalId: string | null;
      evidenceHash: string;
      actorId: string;
      summaryJson: string;
      createdAt: Date;
    }>;
  }) {
    return {
      id: intent.id,
      reportId: intent.reportId,
      confirmationId: intent.confirmationId,
      confirmedVersionId: intent.confirmedVersionId,
      connectionId: intent.connectionId,
      channel: intent.channel,
      status: intent.status,
      version: intent.version ?? 1,
      jobId: intent.jobId,
      externalId: intent.externalId,
      externalUrl: intent.externalUrl,
      attemptCount: intent.attemptCount,
      lastErrorCode: intent.lastErrorCode,
      lastErrorSummary: intent.lastErrorSummary,
      recoveryStatus: intent.recoveryStatus ?? 'not_required',
      lastRecoveryAt: intent.lastRecoveryAt?.toISOString() ?? null,
      resolvedBy: intent.resolvedBy ?? null,
      resolvedAt: intent.resolvedAt?.toISOString() ?? null,
      resolutionReason: intent.resolutionReason ?? null,
      createdAt: intent.createdAt.toISOString(),
      updatedAt: intent.updatedAt.toISOString(),
      ...(intent.attempts
        ? {
            attempts: intent.attempts.map((attempt) => ({
              ...attempt,
              retryAt: attempt.retryAt?.toISOString() ?? null,
              startedAt: attempt.startedAt.toISOString(),
              completedAt: attempt.completedAt?.toISOString() ?? null,
            })),
          }
        : {}),
      ...(intent.recoveryChecks
        ? {
            recoveryChecks: intent.recoveryChecks.map((check) => ({
              ...check,
              summary: this.parseObject(check.summaryJson),
              summaryJson: undefined,
              queryWindowStart: check.queryWindowStart?.toISOString() ?? null,
              queryWindowEnd: check.queryWindowEnd?.toISOString() ?? null,
              createdAt: check.createdAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  private parseObject(value: unknown): Record<string, unknown> {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private parseArray(value: unknown): unknown[] {
    try {
      const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private throwVersionConflict(): never {
    throw new DomainError(errorCodes.versionConflict, '周报发生并发修改，请刷新后重试', {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }
}
