import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma, type WeeklyReport, type WeeklyReportReminderOccurrence } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import {
  buildWeeklyReminderSchedule,
  newId,
  requestHash,
  type WeeklyReminderType,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { InstanceLeaseService } from '../jobs/instance-lease.service.js';
import { WeeklyReportNotificationLedgerService } from './weekly-report-notification-ledger.service.js';
import {
  buildWeeklyReportRobotNotification,
  type WeeklyReportRobotNotificationFacts,
} from './weekly-report-robot-notification.js';

const planningWeeks = 9;

@Injectable()
export class WeeklyReportReminderSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WeeklyReportReminderSchedulerService.name);
  private syncing = false;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly lease: InstanceLeaseService,
    private readonly ledger: WeeklyReportNotificationLedgerService,
    private readonly audit: AuditService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    if (this.lease.isHeld) await this.reconcile(new Date());
  }

  @Interval(30_000)
  public async tick(): Promise<void> {
    if (!this.lease.isHeld) return;
    await this.reconcile(new Date());
  }

  /**
   * 每轮都重建“当前周 + 未来八周”的缺失 occurrence；即使应用长期休眠，恢复后仍能补出当前周并判断宽限。
   */
  public async reconcile(now: Date): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const policies = await this.prisma.weeklyReportReminderPolicy.findMany({
        include: { robotConnection: true },
      });
      for (const policy of policies) {
        await this.cancelStaleOccurrences(policy.id, policy.version, policy.enabled, now);
        if (!policy.enabled) continue;
        const plans = buildWeeklyReminderSchedule(
          {
            timezone: 'Asia/Shanghai',
            workingWeekdays: this.weekdays(policy.workingWeekdaysJson),
            generation: {
              enabled: policy.generationEnabled,
              weekday: policy.generationWeekday,
              time: policy.generationTime,
            },
            confirmation: {
              enabled: policy.confirmationEnabled,
              weekday: policy.confirmationWeekday,
              time: policy.confirmationTime,
            },
            deadline: {
              enabled: policy.deadlineEnabled,
              weekday: policy.deadlineWeekday,
              time: policy.deadlineTime,
            },
            graceMinutes: policy.graceMinutes,
          },
          now,
          planningWeeks,
        );
        const existingPlans = await this.prisma.weeklyReportReminderOccurrence.findMany({
          where: { policyId: policy.id, policyVersion: policy.version },
          select: { cycleKey: true, reminderType: true },
        });
        const existingKeys = new Set(
          existingPlans.map((plan) => `${plan.cycleKey}:${plan.reminderType}`),
        );
        for (const plan of plans) {
          if (existingKeys.has(`${plan.cycleKey}:${plan.reminderType}`)) continue;
          try {
            await this.prisma.weeklyReportReminderOccurrence.create({
              data: {
                id: newId(),
                policyId: policy.id,
                policyVersion: policy.version,
                reminderType: plan.reminderType,
                cycleKey: plan.cycleKey,
                periodStart: plan.periodStart,
                periodEnd: plan.periodEnd,
                reportDate: plan.reportDate,
                scheduledFor: plan.scheduledFor,
                graceUntil: plan.graceUntil,
              },
            });
          } catch (error) {
            // SQLite 不支持 createMany.skipDuplicates，依靠复合唯一键收敛重复轮询和重启补计划。
            if (!(
              error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
            )) {
              throw error;
            }
          }
        }
      }
      const due = await this.prisma.weeklyReportReminderOccurrence.findMany({
        where: { status: 'planned', scheduledFor: { lte: now } },
        include: { policy: { include: { robotConnection: true } } },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        take: 100,
      });
      for (const occurrence of due) {
        try {
          await this.processOccurrence(occurrence, now);
        } catch (error) {
          const code =
            error instanceof DomainError ? error.code : 'WEEKLY_REMINDER_RECONCILE_FAILED';
          this.logger.warn(`提醒 ${occurrence.id} 本轮处理失败：${code}`);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async processOccurrence(
    occurrence: WeeklyReportReminderOccurrence & {
      policy: Prisma.WeeklyReportReminderPolicyGetPayload<{ include: { robotConnection: true } }>;
    },
    now: Date,
  ): Promise<void> {
    if (!occurrence.policy.enabled || occurrence.policy.version !== occurrence.policyVersion) {
      await this.cancelOccurrence(occurrence, '策略已停用或版本已变化', now);
      return;
    }
    const report = await this.prisma.weeklyReport.findFirst({
      where: {
        ownerProfileId: occurrence.policy.profileId,
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        archivedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    const skipReason =
      now > occurrence.graceUntil
        ? 'MISSED_GRACE_WINDOW'
        : this.fulfilledReason(occurrence.reminderType as WeeklyReminderType, report);
    const facts = this.facts(occurrence, report);
    if (skipReason) {
      await this.recordSkipped(occurrence, report, facts, skipReason, now);
      return;
    }
    await this.queue(occurrence, report, facts, now);
  }

  private async queue(
    occurrence: WeeklyReportReminderOccurrence,
    report: WeeklyReport | null,
    facts: WeeklyReportRobotNotificationFacts,
    now: Date,
  ): Promise<void> {
    const policy = await this.prisma.weeklyReportReminderPolicy.findUniqueOrThrow({
      where: { id: occurrence.policyId },
      include: { robotConnection: true },
    });
    if (!policy.robotConnectionId || !policy.robotConnection) {
      await this.cancelOccurrence(occurrence, '提醒机器人已不存在', now);
      return;
    }
    const connectionId = policy.robotConnectionId;
    const robotConfigJson = policy.robotConnection.configJson;
    const message = buildWeeklyReportRobotNotification(facts);
    const jobId = newId();
    await this.prisma.$transaction(async (tx) => {
      const reserved = await this.ledger.reserveInTransaction(tx, {
        reportId: report?.id ?? null,
        connectionId,
        notificationType: occurrence.reminderType as WeeklyReminderType,
        businessObjectKey: this.businessObjectKey(occurrence),
        stateVersion: occurrence.policyVersion,
        contentHash: requestHash({ notificationType: occurrence.reminderType, message }),
        messageFacts: facts,
        quietWindowMinutes: this.quietWindowMinutes(robotConfigJson),
        scheduledFor: occurrence.scheduledFor,
        jobId,
        now,
      });
      if (reserved.disposition !== 'created') {
        throw new DomainError(
          'WEEKLY_REMINDER_RESERVATION_CONFLICT',
          '提醒 occurrence 已存在通知账本事实',
          { httpStatus: 409 },
        );
      }
      await tx.job.create({
        data: {
          id: jobId,
          type: 'weekly-report.notification',
          payloadRef: reserved.notification.id,
          payloadSummary: JSON.stringify({
            reportId: report?.id ?? null,
            reminderOccurrenceId: occurrence.id,
            notificationId: reserved.notification.id,
            notificationType: occurrence.reminderType,
            connectionId: policy.robotConnectionId,
            recoveredAfterSleep: now > occurrence.scheduledFor,
          }),
          scheduledAt: now,
          maxAttempts: 1,
          dedupeKey: `weekly-report.notification:${reserved.notification.id}`,
        },
      });
      const changed = await tx.weeklyReportReminderOccurrence.updateMany({
        where: { id: occurrence.id, status: 'planned', version: occurrence.version },
        data: {
          status: 'queued',
          reportId: report?.id ?? null,
          notificationId: reserved.notification.id,
          jobId,
          queuedAt: now,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError('WEEKLY_REMINDER_VERSION_CONFLICT', '提醒已由其他调度轮次处理', {
          httpStatus: 409,
        });
      }
      await this.audit.recordInTransaction(tx, {
        actorType: 'scheduler',
        actorId: policy.profileId,
        action: 'weekly_report.reminder_queued',
        targetType: 'weekly_report_reminder_occurrence',
        targetId: occurrence.id,
        correlationId: `scheduler:${occurrence.id}`,
        outcome: 'succeeded',
        after: {
          policyId: policy.id,
          policyVersion: policy.version,
          reminderType: occurrence.reminderType,
          cycleKey: occurrence.cycleKey,
          scheduledFor: occurrence.scheduledFor.toISOString(),
          graceUntil: occurrence.graceUntil.toISOString(),
          recoveredAfterSleep: now > occurrence.scheduledFor,
        },
        clientSessionHash: requestHash({ component: 'weekly-report-reminder-scheduler' }),
      });
    });
  }

  private async recordSkipped(
    occurrence: WeeklyReportReminderOccurrence,
    report: WeeklyReport | null,
    facts: WeeklyReportRobotNotificationFacts,
    reason: string,
    now: Date,
  ): Promise<void> {
    const policy = await this.prisma.weeklyReportReminderPolicy.findUniqueOrThrow({
      where: { id: occurrence.policyId },
      include: { robotConnection: true },
    });
    if (!policy.robotConnectionId || !policy.robotConnection) {
      await this.cancelOccurrence(occurrence, '提醒机器人已不存在', now);
      return;
    }
    const connectionId = policy.robotConnectionId;
    const robotConfigJson = policy.robotConnection.configJson;
    const message = buildWeeklyReportRobotNotification(facts);
    await this.prisma.$transaction(async (tx) => {
      const reserved = await this.ledger.reserveInTransaction(tx, {
        reportId: report?.id ?? null,
        connectionId,
        notificationType: occurrence.reminderType as WeeklyReminderType,
        businessObjectKey: this.businessObjectKey(occurrence),
        stateVersion: occurrence.policyVersion,
        contentHash: requestHash({ notificationType: occurrence.reminderType, message }),
        messageFacts: facts,
        quietWindowMinutes: this.quietWindowMinutes(robotConfigJson),
        scheduledFor: occurrence.scheduledFor,
        now,
      });
      if (reserved.disposition !== 'created') {
        throw new DomainError('WEEKLY_REMINDER_RESERVATION_CONFLICT', '提醒跳过事实已存在', {
          httpStatus: 409,
        });
      }
      await tx.robotNotification.update({
        where: { id: reserved.notification.id },
        data: {
          status: 'skipped',
          skippedAt: now,
          skipReason: reason,
          version: { increment: 1 },
        },
      });
      const changed = await tx.weeklyReportReminderOccurrence.updateMany({
        where: { id: occurrence.id, status: 'planned', version: occurrence.version },
        data: {
          status: 'skipped',
          reportId: report?.id ?? null,
          notificationId: reserved.notification.id,
          skippedAt: now,
          skipReason: reason,
          completedAt: now,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError('WEEKLY_REMINDER_VERSION_CONFLICT', '提醒已由其他调度轮次处理', {
          httpStatus: 409,
        });
      }
      await this.audit.recordInTransaction(tx, {
        actorType: 'scheduler',
        actorId: policy.profileId,
        action: 'weekly_report.reminder_skipped',
        targetType: 'weekly_report_reminder_occurrence',
        targetId: occurrence.id,
        correlationId: `scheduler:${occurrence.id}`,
        outcome: 'succeeded',
        after: { reminderType: occurrence.reminderType, cycleKey: occurrence.cycleKey, reason },
        clientSessionHash: requestHash({ component: 'weekly-report-reminder-scheduler' }),
      });
    });
  }

  private async cancelStaleOccurrences(
    policyId: string,
    policyVersion: number,
    enabled: boolean,
    now: Date,
  ): Promise<void> {
    const stale = await this.prisma.weeklyReportReminderOccurrence.findMany({
      where: {
        policyId,
        status: { in: ['planned', 'queued'] },
        ...(enabled ? { policyVersion: { not: policyVersion } } : {}),
      },
      include: { notification: true },
    });
    for (const occurrence of stale) {
      if (occurrence.notification?.status === 'sending') continue;
      await this.prisma.$transaction(async (tx) => {
        if (occurrence.jobId) {
          await tx.job.updateMany({
            where: { id: occurrence.jobId, status: 'queued' },
            data: {
              status: 'cancelled',
              cancelRequested: true,
              completedAt: now,
              lastErrorCode: 'WEEKLY_REMINDER_POLICY_CHANGED',
              lastError: '提醒策略已停用或版本已变化',
            },
          });
        }
        if (occurrence.notificationId) {
          await tx.robotNotification.updateMany({
            where: { id: occurrence.notificationId, status: { in: ['pending', 'queued'] } },
            data: {
              status: 'cancelled',
              skipReason: '提醒策略已停用或版本已变化',
              version: { increment: 1 },
            },
          });
        }
        await tx.weeklyReportReminderOccurrence.updateMany({
          where: { id: occurrence.id, status: occurrence.status, version: occurrence.version },
          data: {
            status: 'cancelled',
            skipReason: '提醒策略已停用或版本已变化',
            completedAt: now,
            version: { increment: 1 },
          },
        });
      });
    }
  }

  private async cancelOccurrence(
    occurrence: WeeklyReportReminderOccurrence,
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.weeklyReportReminderOccurrence.updateMany({
      where: { id: occurrence.id, status: 'planned', version: occurrence.version },
      data: {
        status: 'cancelled',
        skipReason: reason,
        completedAt: now,
        version: { increment: 1 },
      },
    });
  }

  private fulfilledReason(type: WeeklyReminderType, report: WeeklyReport | null): string | null {
    if (type === 'generation_reminder' && report) return 'REPORT_ALREADY_GENERATED';
    if (
      type === 'confirmation_reminder' &&
      report &&
      (report.status === 'confirmed' || report.logDeliveryState === 'submitted')
    ) {
      return 'REPORT_ALREADY_CONFIRMED';
    }
    if (type === 'deadline_reminder' && report?.logDeliveryState === 'submitted') {
      return 'REPORT_ALREADY_SUBMITTED';
    }
    return null;
  }

  private facts(
    occurrence: WeeklyReportReminderOccurrence,
    report: WeeklyReport | null,
  ): WeeklyReportRobotNotificationFacts {
    const base = { periodStart: occurrence.periodStart, periodEnd: occurrence.periodEnd };
    if (occurrence.reminderType === 'generation_reminder') {
      return { type: 'generation_reminder', ...base };
    }
    const draftStatus = this.draftStatus(report);
    if (occurrence.reminderType === 'confirmation_reminder') {
      return { type: 'confirmation_reminder', ...base, draftStatus };
    }
    return {
      type: 'deadline_reminder',
      ...base,
      deadlineText: `${this.shanghaiDateTime(occurrence.scheduledFor)} Asia/Shanghai`,
      draftStatus,
    };
  }

  private draftStatus(report: WeeklyReport | null): string {
    if (!report) return '尚未生成';
    if (report.logDeliveryState === 'submitted') return '已正式提交';
    return (
      {
        collecting: '采集中',
        generated: '已生成待编辑',
        editing: '编辑中待确认',
        confirmed: '已确认待正式提交',
      }[report.status] ?? '状态待核对'
    );
  }

  private businessObjectKey(occurrence: WeeklyReportReminderOccurrence): string {
    return `weekly-reminder:${occurrence.policyId}:v${occurrence.policyVersion}:${occurrence.cycleKey}`;
  }

  private weekdays(value: string): number[] {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'number')) {
      throw new DomainError('WEEKLY_REMINDER_WORKWEEK_CORRUPTED', '提醒工作周配置损坏', {
        httpStatus: 500,
      });
    }
    return parsed;
  }

  private quietWindowMinutes(configJson: string): number {
    try {
      const config = JSON.parse(configJson) as Record<string, unknown>;
      const value = config.quietWindowMinutes;
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_440
        ? value
        : 30;
    } catch {
      return 30;
    }
  }

  private shanghaiDateTime(value: Date): string {
    return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  }
}
