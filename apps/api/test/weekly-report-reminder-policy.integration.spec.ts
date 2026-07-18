import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';
import { WeeklyReportReminderPolicyService } from '../src/modules/weekly-reports/weekly-report-reminder-policy.service.js';

describe('周报提醒策略、工作周与 Asia/Shanghai 预览', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: WeeklyReportReminderPolicyService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-weekly-reminder-policy-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'policy.db').replaceAll('\\', '/')}`,
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
        windowsSid: 'S-1-5-21-weekly-reminder-policy',
        displayName: '提醒策略验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    const prismaService = prisma as unknown as PrismaService;
    service = new WeeklyReportReminderPolicyService(
      prismaService,
      { currentProfileId: 'local-user' } as SessionService,
      new AuditService(prismaService),
      { sessionHash: () => 'reminder-policy-session-hash' } as unknown as LocalSecurityService,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('未保存时返回关闭外发的完整默认策略和未来时刻预览', async () => {
    const result = await service.get(new Date('2026-07-15T00:00:00.000Z'));

    expect(result).toMatchObject({
      id: null,
      version: 0,
      enabled: false,
      robotConnectionId: null,
      timezone: 'Asia/Shanghai',
      workingWeekdays: [1, 2, 3, 4, 5],
      generation: { enabled: true, weekday: 5, time: '14:00' },
      confirmation: { enabled: true, weekday: 5, time: '16:00' },
      deadline: { enabled: true, weekday: 5, time: '17:30' },
      graceMinutes: 120,
    });
    expect(result.upcoming.map((item) => item.scheduledFor).slice(0, 3)).toEqual([
      '2026-07-17T06:00:00.000Z',
      '2026-07-17T08:00:00.000Z',
      '2026-07-17T09:30:00.000Z',
    ]);
    expect(await prisma.weeklyReportReminderPolicy.count()).toBe(0);
  });

  it('启用前强制健康机器人，保存后使用乐观锁并留下非秘密审计', async () => {
    await prisma.integrationConnection.create({
      data: {
        id: 'reminder-robot',
        type: 'dingtalk_robot',
        name: '周报提醒机器人',
        credentialRef: 'vault:robot:reminder',
        enabled: true,
        status: 'unknown',
      },
    });
    const input = {
      version: 0,
      enabled: true,
      robotConnectionId: 'reminder-robot',
      timezone: 'Asia/Shanghai' as const,
      workingWeekdays: [1, 2, 3, 4, 5],
      generation: { enabled: true, weekday: 5, time: '14:00' },
      confirmation: { enabled: true, weekday: 5, time: '16:00' },
      deadline: { enabled: true, weekday: 5, time: '17:30' },
      graceMinutes: 90,
    };
    await expect(
      service.update(input, context(), new Date('2026-07-15T00:00:00.000Z')),
    ).rejects.toMatchObject({ code: 'WEEKLY_REMINDER_ROBOT_NOT_HEALTHY' });
    expect(await prisma.weeklyReportReminderPolicy.count()).toBe(0);

    await prisma.integrationConnection.update({
      where: { id: 'reminder-robot' },
      data: { status: 'healthy', version: { increment: 1 } },
    });
    const saved = await service.update(input, context(), new Date('2026-07-15T00:00:00.000Z'));
    expect(saved).toMatchObject({
      version: 1,
      enabled: true,
      robotConnectionId: 'reminder-robot',
      graceMinutes: 90,
    });
    expect(await prisma.auditEvent.count({ where: { targetId: saved.id! } })).toBe(1);
    const plannedOccurrence = await prisma.weeklyReportReminderOccurrence.create({
      data: {
        id: 'policy-update-planned-occurrence',
        policyId: saved.id!,
        policyVersion: saved.version,
        reminderType: 'generation_reminder',
        cycleKey: '2026-07-20:2026-07-24',
        periodStart: '2026-07-20',
        periodEnd: '2026-07-24',
        reportDate: '2026-07-24',
        scheduledFor: new Date('2026-07-24T06:00:00.000Z'),
        graceUntil: new Date('2026-07-24T07:30:00.000Z'),
      },
    });

    await expect(
      service.update({ ...input, enabled: false }, context(), new Date('2026-07-15T00:00:00.000Z')),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const disabled = await service.update(
      { ...input, version: saved.version, enabled: false },
      context(),
      new Date('2026-07-15T00:00:00.000Z'),
    );
    expect(disabled).toMatchObject({ version: 2, enabled: false });
    expect(
      await prisma.weeklyReportReminderOccurrence.findUniqueOrThrow({
        where: { id: plannedOccurrence.id },
      }),
    ).toMatchObject({
      status: 'cancelled',
      skipReason: '提醒策略已由用户修改，旧版本计划已取消',
    });
  });

  it('拒绝提醒顺序倒置，且不会把无效策略写入数据库', async () => {
    const current = await service.get();
    await expect(
      service.update(
        {
          version: current.version,
          enabled: false,
          robotConnectionId: current.robotConnectionId,
          timezone: 'Asia/Shanghai',
          workingWeekdays: [1, 2, 3, 4, 5],
          generation: { enabled: true, weekday: 5, time: '14:00' },
          confirmation: { enabled: true, weekday: 5, time: '13:59' },
          deadline: { enabled: true, weekday: 5, time: '17:30' },
          graceMinutes: 120,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'WEEKLY_REMINDER_ORDER_INVALID' });
    expect(
      await prisma.weeklyReportReminderPolicy.findUniqueOrThrow({ where: { id: current.id! } }),
    ).toMatchObject({ version: current.version, confirmationTime: '16:00' });
  });

  function context() {
    return { correlationId: 'reminder-policy-correlation', sessionId: 'reminder-policy-session' };
  }
});
