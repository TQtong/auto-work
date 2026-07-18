import { Injectable } from '@nestjs/common';
import type { RobotNotification } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { NotifyWeeklyReportFailureInput } from './weekly-report.schemas.js';
import { WeeklyReportNotificationLedgerService } from './weekly-report-notification-ledger.service.js';
import { buildWeeklyReportRobotNotification } from './weekly-report-robot-notification.js';

interface NotificationContext {
  correlationId: string;
  sessionId: string;
  idempotencyRecordId: string;
}

@Injectable()
export class WeeklyReportNotificationService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly ledger: WeeklyReportNotificationLedgerService,
  ) {}

  public async list(reportId: string) {
    await this.requireOwnedReport(reportId);
    const rows = await this.prisma.robotNotification.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  public async notifyFailure(
    reportId: string,
    input: NotifyWeeklyReportFailureInput,
    context: NotificationContext,
  ) {
    const [report, failedIntent, robot] = await Promise.all([
      this.prisma.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      }),
      this.prisma.deliveryIntent.findFirst({
        where: { id: input.failedDeliveryIntentId, reportId },
      }),
      this.prisma.integrationConnection.findUnique({ where: { id: input.robotConnectionId } }),
    ]);
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
    if (report.version !== input.reportVersion) {
      throw new DomainError(errorCodes.versionConflict, '周报发生并发修改，请刷新后重试', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    if (
      !failedIntent ||
      failedIntent.channel !== 'dingtalk_log' ||
      failedIntent.status !== 'failed'
    ) {
      throw new DomainError(
        'DINGTALK_LOG_FAILURE_FACT_REQUIRED',
        '只有明确失败的正式日志事实才能生成失败提醒；unknown 必须先核对结果',
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    this.assertRobot(robot);
    const config = this.object(robot.configJson);
    const quietWindowMinutes = this.quietWindowMinutes(config.quietWindowMinutes);
    const facts = {
      type: 'submission_failure' as const,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      stage: '钉钉正式日志提交',
      safeErrorSummary: this.safeError(failedIntent.lastErrorSummary ?? failedIntent.lastErrorCode),
    };
    const message = buildWeeklyReportRobotNotification(facts);
    const jobId = newId();
    const reservation = await this.prisma.$transaction(async (tx) => {
      const reserved = await this.ledger.reserveInTransaction(tx, {
        reportId,
        connectionId: robot.id,
        notificationType: 'submission_failure',
        businessObjectKey: `delivery-intent:${failedIntent.id}`,
        stateVersion: failedIntent.version,
        contentHash: requestHash({ notificationType: 'submission_failure', message }),
        messageFacts: facts,
        quietWindowMinutes,
        scheduledFor: new Date(),
        jobId,
      });
      if (reserved.disposition === 'created') {
        await tx.job.create({
          data: {
            id: jobId,
            type: 'weekly-report.notification',
            payloadRef: reserved.notification.id,
            payloadSummary: JSON.stringify({
              reportId,
              notificationId: reserved.notification.id,
              notificationType: 'submission_failure',
              connectionId: robot.id,
            }),
            scheduledAt: new Date(),
            maxAttempts: 1,
            dedupeKey: `weekly-report.notification:${reserved.notification.id}`,
          },
        });
      }
      const response = {
        notification: this.serialize(reserved.notification),
        disposition: reserved.disposition,
        jobId: reserved.disposition === 'created' ? jobId : reserved.notification.jobId,
      };
      await tx.idempotencyRecord.update({
        where: { id: context.idempotencyRecordId },
        data: {
          state: 'completed',
          httpStatus: 202,
          responseJson: JSON.stringify(response),
          errorCode: null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.failure_notification_requested',
        targetType: 'robot_notification',
        targetId: reserved.notification.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          reportId,
          failedDeliveryIntentId: failedIntent.id,
          connectionId: robot.id,
          disposition: reserved.disposition,
          contentHash: reserved.notification.contentHash,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return response;
    });
    return reservation;
  }

  private assertRobot(
    robot: {
      id: string;
      type: string;
      enabled: boolean;
      status: string;
      credentialRef: string | null;
      configJson: string;
    } | null,
  ): asserts robot is NonNullable<typeof robot> {
    if (
      !robot ||
      robot.type !== 'dingtalk_robot' ||
      !robot.enabled ||
      robot.status !== 'healthy' ||
      !robot.credentialRef
    ) {
      throw new DomainError('DINGTALK_ROBOT_NOT_HEALTHY', '失败提醒要求已启用且测试健康的机器人', {
        httpStatus: 422,
        suggestedAction: 'reconfigure',
      });
    }
  }

  private async requireOwnedReport(reportId: string): Promise<void> {
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!report) throw new DomainError(errorCodes.notFound, '周报不存在', { httpStatus: 404 });
  }

  private serialize(row: RobotNotification) {
    return {
      id: row.id,
      reportId: row.reportId,
      connectionId: row.connectionId,
      deliveryIntentId: row.deliveryIntentId,
      notificationType: row.notificationType,
      stateVersion: row.stateVersion,
      status: row.status,
      coalescedCount: row.coalescedCount,
      scheduledFor: row.scheduledFor.toISOString(),
      quietWindowStartedAt: row.quietWindowStartedAt.toISOString(),
      quietWindowEndsAt: row.quietWindowEndsAt.toISOString(),
      providerRequestId: row.providerRequestId,
      providerCallCount: row.providerCallCount,
      retryDelaysMs: this.numberArray(row.retryDelaysJson),
      lastErrorCode: row.lastErrorCode,
      lastErrorSummary: row.lastErrorSummary,
      sentAt: row.sentAt?.toISOString() ?? null,
      skippedAt: row.skippedAt?.toISOString() ?? null,
      skipReason: row.skipReason,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private quietWindowMinutes(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_440
      ? value
      : 30;
  }

  private safeError(value: string | null): string {
    return (value || '未知错误')
      .replace(
        /(?:Bearer|PRIVATE-TOKEN|Authorization|token|secret|webhook)\s*[:=]?\s*\S+/giu,
        '[REDACTED]',
      )
      .replace(/[\0\r\n\t]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 240);
  }

  private object(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private numberArray(value: string): number[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is number => typeof item === 'number')
        : [];
    } catch {
      return [];
    }
  }
}
