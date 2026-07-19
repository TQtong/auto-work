import { Injectable } from '@nestjs/common';
import type { WeeklyReportReminderOccurrence, WeeklyReportReminderPolicy } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { buildWeeklyReminderSchedule, newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { UpdateWeeklyReminderPolicyInput } from './weekly-report.schemas.js';

interface ReminderPolicyContext {
  correlationId: string;
  sessionId: string;
}

const defaultPolicy = {
  enabled: false,
  robotConnectionId: null,
  timezone: 'Asia/Shanghai' as const,
  workingWeekdays: [1, 2, 3, 4, 5],
  generation: { enabled: true, weekday: 5, time: '14:00' },
  confirmation: { enabled: true, weekday: 5, time: '16:00' },
  deadline: { enabled: true, weekday: 5, time: '17:30' },
  graceMinutes: 120,
};

@Injectable()
export class WeeklyReportReminderPolicyService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async get(now = new Date()) {
    const row = await this.prisma.weeklyReportReminderPolicy.findUnique({
      where: { profileId: this.sessions.currentProfileId },
    });
    return this.serialize(row, now, row ? await this.recentOccurrences(row.id) : []);
  }

  public async update(
    input: UpdateWeeklyReminderPolicyInput,
    context: ReminderPolicyContext,
    now = new Date(),
  ) {
    // 领域计算器同时验证工作周、时刻和三类提醒的严格先后顺序。
    buildWeeklyReminderSchedule(input, now, 2);
    const robot = input.robotConnectionId
      ? await this.prisma.integrationConnection.findUnique({
          where: { id: input.robotConnectionId },
        })
      : null;
    if (input.robotConnectionId && (!robot || robot.type !== 'dingtalk_robot')) {
      throw new DomainError('WEEKLY_REMINDER_ROBOT_INVALID', '所选连接不是钉钉机器人', {
        httpStatus: 422,
      });
    }
    if (
      input.enabled &&
      (!robot?.enabled ||
        robot.status !== 'healthy' ||
        !robot.credentialRef ||
        robot.pendingCredentialRef)
    ) {
      throw new DomainError(
        'WEEKLY_REMINDER_ROBOT_NOT_HEALTHY',
        '启用提醒前必须选择已测试健康、凭证已生效的钉钉机器人',
        { httpStatus: 422, suggestedAction: 'reconfigure' },
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.weeklyReportReminderPolicy.findUnique({
        where: { profileId: this.sessions.currentProfileId },
      });
      if (!existing && input.version !== 0) this.throwVersionConflict();
      if (existing && existing.version !== input.version) this.throwVersionConflict();
      const data = {
        robotConnectionId: input.robotConnectionId,
        enabled: input.enabled,
        timezone: input.timezone,
        workingWeekdaysJson: JSON.stringify(
          [...input.workingWeekdays].sort((left, right) => left - right),
        ),
        generationEnabled: input.generation.enabled,
        generationWeekday: input.generation.weekday,
        generationTime: input.generation.time,
        confirmationEnabled: input.confirmation.enabled,
        confirmationWeekday: input.confirmation.weekday,
        confirmationTime: input.confirmation.time,
        deadlineEnabled: input.deadline.enabled,
        deadlineWeekday: input.deadline.weekday,
        deadlineTime: input.deadline.time,
        graceMinutes: input.graceMinutes,
      };
      const saved = existing
        ? await tx.weeklyReportReminderPolicy.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.weeklyReportReminderPolicy.create({
            data: {
              id: newId(),
              profileId: this.sessions.currentProfileId,
              ...data,
            },
          });
      if (existing) {
        const activeOccurrences = await tx.weeklyReportReminderOccurrence.findMany({
          where: { policyId: existing.id, status: { in: ['planned', 'queued'] } },
          include: { notification: true },
        });
        for (const occurrence of activeOccurrences) {
          // 已进入 sending 的机器人请求无法撤回；其结果仍由通知 handler 和 unknown 恢复链收敛。
          if (occurrence.notification?.status === 'sending') continue;
          const cancellationReason = '提醒策略已由用户修改，旧版本计划已取消';
          if (occurrence.jobId) {
            await tx.job.updateMany({
              where: { id: occurrence.jobId, status: 'queued' },
              data: {
                status: 'cancelled',
                cancelRequested: true,
                completedAt: now,
                lastErrorCode: 'WEEKLY_REMINDER_POLICY_CHANGED',
                lastError: cancellationReason,
              },
            });
            await tx.job.updateMany({
              where: { id: occurrence.jobId, status: 'running' },
              data: {
                cancelRequested: true,
                lastErrorCode: 'WEEKLY_REMINDER_POLICY_CHANGED',
                lastError: cancellationReason,
              },
            });
          }
          if (occurrence.notificationId) {
            await tx.robotNotification.updateMany({
              where: { id: occurrence.notificationId, status: { in: ['pending', 'queued'] } },
              data: {
                status: 'cancelled',
                skipReason: cancellationReason,
                version: { increment: 1 },
              },
            });
          }
          await tx.weeklyReportReminderOccurrence.updateMany({
            where: { id: occurrence.id, status: occurrence.status, version: occurrence.version },
            data: {
              status: 'cancelled',
              skipReason: cancellationReason,
              completedAt: now,
              version: { increment: 1 },
            },
          });
        }
      }
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.reminder_policy_updated',
        targetType: 'weekly_report_reminder_policy',
        targetId: saved.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        before: existing ? this.auditFacts(existing) : null,
        after: this.auditFacts(saved),
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return saved;
    });
    return this.serialize(row, now, await this.recentOccurrences(row.id));
  }

  private serialize(
    row: WeeklyReportReminderPolicy | null,
    now: Date,
    occurrences: WeeklyReportReminderOccurrence[],
  ) {
    const policy = row ? this.policyInput(row) : defaultPolicy;
    const upcoming = buildWeeklyReminderSchedule(policy, now, 3)
      .filter((plan) => plan.scheduledFor >= now)
      .slice(0, 6)
      .map((plan) => ({
        ...plan,
        scheduledFor: plan.scheduledFor.toISOString(),
        graceUntil: plan.graceUntil.toISOString(),
      }));
    return {
      id: row?.id ?? null,
      version: row?.version ?? 0,
      ...policy,
      upcoming,
      recentOccurrences: occurrences.map((occurrence) => ({
        id: occurrence.id,
        policyVersion: occurrence.policyVersion,
        reminderType: occurrence.reminderType,
        cycleKey: occurrence.cycleKey,
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        reportDate: occurrence.reportDate,
        scheduledFor: occurrence.scheduledFor.toISOString(),
        graceUntil: occurrence.graceUntil.toISOString(),
        status: occurrence.status,
        reportId: occurrence.reportId,
        notificationId: occurrence.notificationId,
        jobId: occurrence.jobId,
        queuedAt: occurrence.queuedAt?.toISOString() ?? null,
        skippedAt: occurrence.skippedAt?.toISOString() ?? null,
        skipReason: occurrence.skipReason,
        completedAt: occurrence.completedAt?.toISOString() ?? null,
        lastErrorCode: occurrence.lastErrorCode,
        version: occurrence.version,
      })),
      createdAt: row?.createdAt.toISOString() ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  private recentOccurrences(policyId: string): Promise<WeeklyReportReminderOccurrence[]> {
    return this.prisma.weeklyReportReminderOccurrence.findMany({
      where: { policyId },
      orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    });
  }

  private policyInput(row: WeeklyReportReminderPolicy) {
    return {
      enabled: row.enabled,
      robotConnectionId: row.robotConnectionId,
      timezone: 'Asia/Shanghai' as const,
      workingWeekdays: this.weekdays(row.workingWeekdaysJson),
      generation: {
        enabled: row.generationEnabled,
        weekday: row.generationWeekday,
        time: row.generationTime,
      },
      confirmation: {
        enabled: row.confirmationEnabled,
        weekday: row.confirmationWeekday,
        time: row.confirmationTime,
      },
      deadline: {
        enabled: row.deadlineEnabled,
        weekday: row.deadlineWeekday,
        time: row.deadlineTime,
      },
      graceMinutes: row.graceMinutes,
    };
  }

  private weekdays(value: string): number[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'number')) return parsed;
    } catch {
      // 数据库触发器和 API 已阻断无效写入；读取异常时仍使用安全默认值供用户修复。
    }
    return [...defaultPolicy.workingWeekdays];
  }

  private auditFacts(row: WeeklyReportReminderPolicy) {
    return {
      enabled: row.enabled,
      robotConnectionId: row.robotConnectionId,
      timezone: row.timezone,
      workingWeekdaysJson: row.workingWeekdaysJson,
      generation: [row.generationEnabled, row.generationWeekday, row.generationTime],
      confirmation: [row.confirmationEnabled, row.confirmationWeekday, row.confirmationTime],
      deadline: [row.deadlineEnabled, row.deadlineWeekday, row.deadlineTime],
      graceMinutes: row.graceMinutes,
      version: row.version,
    };
  }

  private throwVersionConflict(): never {
    throw new DomainError(errorCodes.versionConflict, '提醒策略已被修改，请刷新后重试', {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }
}
