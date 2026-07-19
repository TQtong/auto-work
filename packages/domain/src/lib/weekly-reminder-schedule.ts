import { DomainError } from '@auto-work/contracts';

export type WeeklyReminderType =
  'generation_reminder' | 'confirmation_reminder' | 'deadline_reminder';

export interface WeeklyReminderClock {
  enabled: boolean;
  weekday: number;
  time: string;
}

export interface WeeklyReminderScheduleInput {
  timezone: 'Asia/Shanghai';
  workingWeekdays: number[];
  generation: WeeklyReminderClock;
  confirmation: WeeklyReminderClock;
  deadline: WeeklyReminderClock;
  graceMinutes: number;
}

export interface WeeklyReminderOccurrencePlan {
  cycleKey: string;
  reminderType: WeeklyReminderType;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  scheduledFor: Date;
  graceUntil: Date;
}

const shanghaiOffsetMilliseconds = 8 * 3_600_000;
const dayMilliseconds = 86_400_000;

/**
 * 以 Asia/Shanghai 的自然周生成确定性提醒计划。返回 Date 均为 UTC 瞬间，落库和队列不保存模糊本地时间。
 */
export function buildWeeklyReminderSchedule(
  input: WeeklyReminderScheduleInput,
  anchor: Date,
  weeks: number,
): WeeklyReminderOccurrencePlan[] {
  assertScheduleInput(input, weeks);
  const localAnchor = new Date(anchor.getTime() + shanghaiOffsetMilliseconds);
  const anchorWeekday = isoWeekday(localAnchor);
  const mondayLocal = Date.UTC(
    localAnchor.getUTCFullYear(),
    localAnchor.getUTCMonth(),
    localAnchor.getUTCDate() - (anchorWeekday - 1),
  );
  const workingWeekdays = [...input.workingWeekdays].sort((left, right) => left - right);
  const clocks: Array<[WeeklyReminderType, WeeklyReminderClock]> = [
    ['generation_reminder', input.generation],
    ['confirmation_reminder', input.confirmation],
    ['deadline_reminder', input.deadline],
  ];
  const plans: WeeklyReminderOccurrencePlan[] = [];

  for (let weekOffset = 0; weekOffset < weeks; weekOffset += 1) {
    const weekMonday = mondayLocal + weekOffset * 7 * dayMilliseconds;
    const periodStart = businessDate(weekMonday + (workingWeekdays[0]! - 1) * dayMilliseconds);
    const periodEnd = businessDate(
      weekMonday + (workingWeekdays[workingWeekdays.length - 1]! - 1) * dayMilliseconds,
    );
    const cycleKey = `${periodStart}:${periodEnd}`;
    for (const [reminderType, clock] of clocks) {
      if (!clock.enabled) continue;
      const [hour, minute] = parseClock(clock.time);
      const reminderLocal = new Date(weekMonday + (clock.weekday - 1) * dayMilliseconds);
      const scheduledFor = new Date(
        Date.UTC(
          reminderLocal.getUTCFullYear(),
          reminderLocal.getUTCMonth(),
          reminderLocal.getUTCDate(),
          hour,
          minute,
        ) - shanghaiOffsetMilliseconds,
      );
      plans.push({
        cycleKey,
        reminderType,
        periodStart,
        periodEnd,
        reportDate: periodEnd,
        scheduledFor,
        graceUntil: new Date(scheduledFor.getTime() + input.graceMinutes * 60_000),
      });
    }
  }
  return plans.sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime());
}

function assertScheduleInput(input: WeeklyReminderScheduleInput, weeks: number): void {
  if (input.timezone !== 'Asia/Shanghai') {
    throw new DomainError('WEEKLY_REMINDER_TIMEZONE_UNSUPPORTED', '周报提醒只支持 Asia/Shanghai', {
      httpStatus: 422,
    });
  }
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 53) {
    throw new DomainError('WEEKLY_REMINDER_HORIZON_INVALID', '提醒计划周数必须在 1 到 53 之间', {
      httpStatus: 422,
    });
  }
  const weekdays = input.workingWeekdays;
  if (
    weekdays.length === 0 ||
    weekdays.length > 7 ||
    new Set(weekdays).size !== weekdays.length ||
    weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
  ) {
    throw new DomainError('WEEKLY_REMINDER_WORKWEEK_INVALID', '工作星期必须是不重复的 1 到 7', {
      httpStatus: 422,
    });
  }
  if (
    !Number.isInteger(input.graceMinutes) ||
    input.graceMinutes < 0 ||
    input.graceMinutes > 1_440
  ) {
    throw new DomainError('WEEKLY_REMINDER_GRACE_INVALID', '休眠补发宽限必须在 0 到 1440 分钟', {
      httpStatus: 422,
    });
  }
  for (const clock of [input.generation, input.confirmation, input.deadline]) {
    parseClock(clock.time);
    if (!Number.isInteger(clock.weekday) || !weekdays.includes(clock.weekday)) {
      throw new DomainError(
        'WEEKLY_REMINDER_WEEKDAY_INVALID',
        '启用或停用的提醒星期都必须属于配置的工作周',
        { httpStatus: 422 },
      );
    }
  }
  const enabledOrder = [input.generation, input.confirmation, input.deadline]
    .filter((clock) => clock.enabled)
    .map((clock) => clock.weekday * 1_440 + clockMinutes(clock.time));
  if (enabledOrder.some((value, index) => index > 0 && value <= enabledOrder[index - 1]!)) {
    throw new DomainError(
      'WEEKLY_REMINDER_ORDER_INVALID',
      '生成、确认和截止提醒必须按严格递增的工作周时间排列',
      { httpStatus: 422 },
    );
  }
}

function parseClock(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new DomainError('WEEKLY_REMINDER_TIME_INVALID', '提醒时刻必须使用有效的 HH:mm 格式', {
      httpStatus: 422,
    });
  }
  return [hour, minute];
}

function clockMinutes(value: string): number {
  const [hour, minute] = parseClock(value);
  return hour * 60 + minute;
}

function isoWeekday(date: Date): number {
  return date.getUTCDay() || 7;
}

function businessDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
