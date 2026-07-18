import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import type { RequestAuditContext } from './profile.service.js';
import type { CreateWorkCalendarVersionInput } from './work-calendar.schemas.js';

const defaultCalendarId = 'enterprise-work-calendar';

@Injectable()
export class WorkCalendarService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async get() {
    const calendar = await this.prisma.workCalendar.findUnique({
      where: { id: defaultCalendarId },
      include: {
        currentVersion: true,
        versions: { orderBy: { versionNo: 'desc' }, take: 100 },
      },
    });
    if (!calendar) return { configured: false, calendar: null, currentVersion: null, versions: [] };
    return {
      configured: Boolean(calendar.currentVersion),
      calendar: { id: calendar.id, name: calendar.name, version: calendar.version },
      currentVersion: calendar.currentVersion
        ? this.serializeVersion(calendar.currentVersion)
        : null,
      versions: calendar.versions.map((version) => this.serializeVersion(version)),
    };
  }

  public async createVersion(input: CreateWorkCalendarVersionInput, context: RequestAuditContext) {
    const normalized = this.normalize(input);
    const contentHash = requestHash(normalized);
    const current = await this.prisma.workCalendar.findUnique({
      where: { id: defaultCalendarId },
      include: { currentVersion: true },
    });
    // 只有当前生效版本完全相同时才算重放；恢复旧日历内容也要产生新的审计版本。
    if (current?.currentVersion?.contentHash === contentHash) {
      return { replayed: true, version: this.serializeVersion(current.currentVersion) };
    }

    try {
      // 正文版本先插入，再用聚合版本条件切换当前指针，保证并发设置不会互相覆盖。
      return await this.prisma.$transaction(async (tx) => {
        const calendar = await tx.workCalendar.findUnique({ where: { id: defaultCalendarId } });
        const aggregate = calendar
          ? calendar
          : await tx.workCalendar.create({
              data: {
                id: defaultCalendarId,
                name: normalized.name,
              },
            });
        const latest = await tx.workCalendarVersion.findFirst({
          where: { calendarId: defaultCalendarId },
          orderBy: { versionNo: 'desc' },
          select: { versionNo: true },
        });
        const version = await tx.workCalendarVersion.create({
          data: {
            id: newId(),
            calendarId: defaultCalendarId,
            versionNo: (latest?.versionNo ?? 0) + 1,
            timezone: normalized.timezone,
            workingWeekdaysJson: JSON.stringify(normalized.workingWeekdays),
            dateOverridesJson: JSON.stringify(normalized.dateOverrides),
            source: normalized.source,
            contentHash,
            createdBy: this.sessions.currentProfileId,
          },
        });
        const changed = await tx.workCalendar.updateMany({
          where: { id: defaultCalendarId, version: aggregate.version },
          data: {
            name: normalized.name,
            currentVersionId: version.id,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new DomainError(
            errorCodes.versionConflict,
            '工作日历已被其他页面修改，请刷新后重试',
            {
              httpStatus: 409,
              suggestedAction: 'refresh',
            },
          );
        }
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: 'work_calendar.version_created',
          targetType: 'work_calendar',
          targetId: defaultCalendarId,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          before: { version: aggregate.version, currentVersionId: aggregate.currentVersionId },
          after: { version: aggregate.version + 1, calendarVersionId: version.id, contentHash },
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        return { replayed: false, version: this.serializeVersion(version) };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError(
          errorCodes.versionConflict,
          '工作日历并发创建了新版本，请刷新后重试',
          {
            httpStatus: 409,
            suggestedAction: 'refresh',
          },
        );
      }
      throw error;
    }
  }

  private normalize(input: CreateWorkCalendarVersionInput) {
    const workingWeekdays = [...new Set(input.workingWeekdays)].sort((left, right) => left - right);
    if (workingWeekdays.length !== input.workingWeekdays.length) {
      throw new DomainError('WORK_CALENDAR_WEEKDAY_DUPLICATE', '工作日星期不能重复', {
        httpStatus: 422,
      });
    }
    const dateOverrides = input.dateOverrides
      .map((override) => {
        this.assertBusinessDate(override.date);
        return {
          date: override.date,
          isWorkday: override.isWorkday,
          ...(override.label ? { label: override.label.trim() } : {}),
        };
      })
      .sort((left, right) => left.date.localeCompare(right.date));
    if (new Set(dateOverrides.map((override) => override.date)).size !== dateOverrides.length) {
      throw new DomainError('WORK_CALENDAR_DATE_DUPLICATE', '同一日期只能配置一条工作日覆盖', {
        httpStatus: 422,
      });
    }
    return {
      name: input.name.trim(),
      timezone: input.timezone,
      workingWeekdays,
      dateOverrides,
      source: input.source,
    };
  }

  private assertBusinessDate(value: string): void {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== (month ?? 0) - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new DomainError('WORK_CALENDAR_DATE_INVALID', `${value} 不是有效业务日期`, {
        httpStatus: 422,
      });
    }
  }

  private serializeVersion(version: {
    id: string;
    versionNo: number;
    timezone: string;
    workingWeekdaysJson: string;
    dateOverridesJson: string;
    source: string;
    contentHash: string;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      versionNo: version.versionNo,
      timezone: version.timezone,
      workingWeekdays: JSON.parse(version.workingWeekdaysJson) as number[],
      dateOverrides: JSON.parse(version.dateOverridesJson) as unknown[],
      source: version.source,
      contentHash: version.contentHash,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }
}
