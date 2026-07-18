import { Injectable } from '@nestjs/common';
import type { RobotNotification } from '@prisma/client';
import {
  DomainError,
  errorCodes,
  weeklyReportWarningRuleCatalog,
  weeklyReportWarningRuleCodes,
  type WeeklyReportWarningRuleCode,
} from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type {
  NotifyWeeklyReportFailureInput,
  NotifyWeeklyReportRiskInput,
} from './weekly-report.schemas.js';
import { WeeklyReportNotificationLedgerService } from './weekly-report-notification-ledger.service.js';
import {
  buildWeeklyReportRobotNotification,
  type WeeklyReportRobotNotificationFacts,
  type WeeklyReportRobotNotificationType,
} from './weekly-report-robot-notification.js';

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
    return this.queueNotification(
      {
        reportId,
        connectionId: robot.id,
        notificationType: 'submission_failure',
        businessObjectKey: `delivery-intent:${failedIntent.id}`,
        stateVersion: failedIntent.version,
        facts,
        quietWindowMinutes,
        auditAction: 'weekly_report.failure_notification_requested',
        auditFacts: { failedDeliveryIntentId: failedIntent.id },
      },
      context,
    );
  }

  public async notifyRisk(
    reportId: string,
    input: NotifyWeeklyReportRiskInput,
    context: NotificationContext,
  ) {
    const [report, version, robot] = await Promise.all([
      this.prisma.weeklyReport.findFirst({
        where: { id: reportId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      }),
      this.prisma.weeklyReportVersion.findFirst({
        where: { id: input.versionId, reportId },
      }),
      this.prisma.integrationConnection.findUnique({ where: { id: input.robotConnectionId } }),
    ]);
    if (!report || !version) {
      throw new DomainError(errorCodes.notFound, '周报或当前版本不存在', { httpStatus: 404 });
    }
    if (report.version !== input.reportVersion || report.currentVersionId !== version.id) {
      throw new DomainError(errorCodes.versionConflict, '周报当前版本已变化，请刷新风险清单', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    this.assertRobot(robot);
    const config = this.object(robot.configJson);
    const configuredCodes = this.severeRiskCodes(config.severeRiskCodes);
    if (configuredCodes.length === 0) {
      throw new DomainError(
        'WEEKLY_REPORT_SEVERE_RISK_RULES_DISABLED',
        '目标机器人尚未配置任何严重风险规则',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }
    const warnings = this.warningFacts(version.warningsJson);
    const warningById = new Map(warnings.map((warning) => [warning.id, warning]));
    const selected = input.warningIds.map((warningId) => warningById.get(warningId));
    if (selected.some((warning) => !warning)) {
      throw new DomainError(
        'WEEKLY_REPORT_RISK_WARNING_INVALID',
        '风险清单包含不属于当前版本的 warning，请刷新后重试',
        { httpStatus: 409, suggestedAction: 'refresh' },
      );
    }
    const selectedWarnings = (selected as Array<(typeof warnings)[number]>).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const unconfiguredCodes = selectedWarnings
      .map((warning) => warning.code)
      .filter((code) => !configuredCodes.includes(code as WeeklyReportWarningRuleCode));
    if (unconfiguredCodes.length > 0) {
      throw new DomainError(
        'WEEKLY_REPORT_RISK_RULE_NOT_CONFIGURED',
        '所选 warning 不属于目标机器人已启用的严重风险规则',
        { httpStatus: 422, details: { unconfiguredCodes }, suggestedAction: 'reconfigure' },
      );
    }
    // 消息事实完全从服务端当前版本提取，客户端只能提交 warning ID，不能注入任意正文。
    const facts = {
      type: 'risk_alert' as const,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      riskSummaries: this.safeRiskSummaries(selectedWarnings.map((warning) => warning.code)),
    };
    const selectedWarningIds = selectedWarnings.map((warning) => warning.id);
    return this.queueNotification(
      {
        reportId,
        connectionId: robot.id,
        notificationType: 'risk_alert',
        businessObjectKey: `weekly-report-risk:${reportId}:${requestHash(selectedWarningIds)}`,
        stateVersion: version.versionNo,
        facts,
        quietWindowMinutes: this.quietWindowMinutes(config.quietWindowMinutes),
        auditAction: 'weekly_report.risk_notification_requested',
        auditFacts: {
          versionId: version.id,
          warningIds: selectedWarningIds,
          warningCodes: selectedWarnings.map((warning) => warning.code),
        },
      },
      context,
    );
  }

  private async queueNotification(
    input: {
      reportId: string;
      connectionId: string;
      notificationType: WeeklyReportRobotNotificationType;
      businessObjectKey: string;
      stateVersion: number;
      facts: WeeklyReportRobotNotificationFacts;
      quietWindowMinutes: number;
      auditAction: string;
      auditFacts: Record<string, unknown>;
    },
    context: NotificationContext,
  ) {
    const message = buildWeeklyReportRobotNotification(input.facts);
    const jobId = newId();
    return this.prisma.$transaction(async (tx) => {
      const reserved = await this.ledger.reserveInTransaction(tx, {
        reportId: input.reportId,
        connectionId: input.connectionId,
        notificationType: input.notificationType,
        businessObjectKey: input.businessObjectKey,
        stateVersion: input.stateVersion,
        contentHash: requestHash({ notificationType: input.notificationType, message }),
        messageFacts: input.facts,
        quietWindowMinutes: input.quietWindowMinutes,
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
              reportId: input.reportId,
              notificationId: reserved.notification.id,
              notificationType: input.notificationType,
              connectionId: input.connectionId,
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
        action: input.auditAction,
        targetType: 'robot_notification',
        targetId: reserved.notification.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          reportId: input.reportId,
          connectionId: input.connectionId,
          disposition: reserved.disposition,
          contentHash: reserved.notification.contentHash,
          ...input.auditFacts,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return response;
    });
  }

  private assertRobot(
    robot: {
      id: string;
      type: string;
      enabled: boolean;
      status: string;
      credentialRef: string | null;
      pendingCredentialRef: string | null;
      configJson: string;
    } | null,
  ): asserts robot is NonNullable<typeof robot> {
    if (
      !robot ||
      robot.type !== 'dingtalk_robot' ||
      !robot.enabled ||
      robot.status !== 'healthy' ||
      !robot.credentialRef ||
      robot.pendingCredentialRef
    ) {
      throw new DomainError('DINGTALK_ROBOT_NOT_HEALTHY', '业务提醒要求已启用且测试健康的机器人', {
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

  private severeRiskCodes(value: unknown): WeeklyReportWarningRuleCode[] {
    const allowed = new Set<string>(weeklyReportWarningRuleCodes);
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (item): item is WeeklyReportWarningRuleCode =>
                typeof item === 'string' && allowed.has(item),
            ),
          ),
        ]
      : [];
  }

  private warningFacts(value: string) {
    let values: unknown = [];
    try {
      values = JSON.parse(value) as unknown;
    } catch {
      values = [];
    }
    if (!Array.isArray(values)) return [];
    return values.flatMap((warning) => {
      if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return [];
      const fact = warning as Record<string, unknown>;
      if (typeof fact.code !== 'string' || typeof fact.message !== 'string') return [];
      const message = fact.message
        .replace(/[\0\r\n\t]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!message) return [];
      return [
        {
          id: requestHash(fact),
          code: fact.code,
          message: message.slice(0, 160),
        },
      ];
    });
  }

  private safeRiskSummaries(codes: string[]): string[] {
    const catalog = new Map<string, string>(
      weeklyReportWarningRuleCatalog.map((rule) => [rule.code, rule.label]),
    );
    const counts = new Map<string, number>();
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    // 群消息只透露规则类别和数量，任务标题、客户名称及来源正文只留在本机工作台。
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => `${catalog.get(code) ?? '严重风险'}（${code}，选中 ${count} 项）`)
      .slice(0, 3);
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
