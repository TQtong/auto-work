import { describe, expect, it } from 'vitest';
import { buildWeeklyReminderSchedule } from '../src/lib/weekly-reminder-schedule.js';

const policy = {
  timezone: 'Asia/Shanghai' as const,
  workingWeekdays: [1, 2, 3, 4, 5],
  generation: { enabled: true, weekday: 5, time: '14:00' },
  confirmation: { enabled: true, weekday: 5, time: '16:00' },
  deadline: { enabled: true, weekday: 5, time: '17:30' },
  graceMinutes: 120,
};

describe('周报提醒 Asia/Shanghai 计划计算', () => {
  it('把本地工作周和三个时刻转换为无歧义 UTC 瞬间', () => {
    const plans = buildWeeklyReminderSchedule(policy, new Date('2026-07-15T00:00:00.000Z'), 1);

    expect(plans.map((plan) => plan.reminderType)).toEqual([
      'generation_reminder',
      'confirmation_reminder',
      'deadline_reminder',
    ]);
    expect(plans[0]).toMatchObject({
      cycleKey: '2026-07-13:2026-07-17',
      periodStart: '2026-07-13',
      periodEnd: '2026-07-17',
      reportDate: '2026-07-17',
    });
    expect(plans.map((plan) => plan.scheduledFor.toISOString())).toEqual([
      '2026-07-17T06:00:00.000Z',
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T09:30:00.000Z',
    ]);
    expect(plans[2].graceUntil.toISOString()).toBe('2026-07-17T11:30:00.000Z');
  });

  it('支持自定义工作周并为连续多周生成稳定周期键', () => {
    const plans = buildWeeklyReminderSchedule(
      {
        ...policy,
        workingWeekdays: [2, 3, 4, 5, 6],
        generation: { enabled: false, weekday: 2, time: '09:00' },
        confirmation: { enabled: false, weekday: 5, time: '16:00' },
        deadline: { enabled: true, weekday: 6, time: '18:00' },
      },
      new Date('2026-07-18T04:00:00.000Z'),
      2,
    );

    expect(plans.map((plan) => plan.cycleKey)).toEqual([
      '2026-07-14:2026-07-18',
      '2026-07-21:2026-07-25',
    ]);
    expect(plans[0].scheduledFor.toISOString()).toBe('2026-07-18T10:00:00.000Z');
  });

  it('拒绝不属于工作周的星期和顺序倒置的提醒', () => {
    expect(() =>
      buildWeeklyReminderSchedule(
        { ...policy, deadline: { enabled: true, weekday: 7, time: '17:30' } },
        new Date(),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'WEEKLY_REMINDER_WEEKDAY_INVALID' }));
    expect(() =>
      buildWeeklyReminderSchedule(
        { ...policy, confirmation: { enabled: true, weekday: 5, time: '13:00' } },
        new Date(),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'WEEKLY_REMINDER_ORDER_INVALID' }));
  });
});
