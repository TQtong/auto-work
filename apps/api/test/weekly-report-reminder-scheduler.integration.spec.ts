import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { DingTalkRobotClient } from '../src/modules/dingtalk/dingtalk-robot.client.js';
import type { InstanceLeaseService } from '../src/modules/jobs/instance-lease.service.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import type { JobHandler } from '../src/modules/jobs/job-registry.service.js';
import { WeeklyReportNotificationHandler } from '../src/modules/weekly-reports/weekly-report-notification.handler.js';
import { WeeklyReportNotificationLedgerService } from '../src/modules/weekly-reports/weekly-report-notification-ledger.service.js';
import { WeeklyReportReminderSchedulerService } from '../src/modules/weekly-reports/weekly-report-reminder-scheduler.service.js';

describe('周报提醒滚动计划、休眠补发与跳过事实', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let scheduler: WeeklyReportReminderSchedulerService;
  let sendText: ReturnType<typeof vi.fn>;
  let notificationHandler: WeeklyReportNotificationHandler;
  let sequence = 0;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-weekly-reminder-scheduler-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'scheduler.db').replaceAll('\\', '/')}`,
    });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      if (migration === '20260719023000_weekly_reminder_occurrences') {
        // 在表重建迁移前写入旧版通知，验证 report_id 改为可空时历史账本完整保留。
        await prisma.userProfile.create({
          data: {
            id: 'reminder-upgrade-profile',
            windowsSid: 'S-1-5-21-reminder-upgrade',
            displayName: '迁移保留验收用户',
          },
        });
        await prisma.integrationConnection.create({
          data: {
            id: 'reminder-upgrade-robot',
            type: 'dingtalk_robot',
            name: '迁移保留机器人',
          },
        });
        await prisma.weeklyReport.create({
          data: {
            id: 'reminder-upgrade-report',
            ownerProfileId: 'reminder-upgrade-profile',
            periodStart: '2026-07-06',
            periodEnd: '2026-07-10',
            reportDate: '2026-07-10',
          },
        });
        await prisma.robotNotification.create({
          data: {
            id: 'reminder-upgrade-notification',
            reportId: 'reminder-upgrade-report',
            connectionId: 'reminder-upgrade-robot',
            notificationType: 'deadline_reminder',
            businessObjectKey: 'upgrade-preservation',
            stateVersion: 1,
            dedupeKey: 'upgrade-preservation-key',
            contentHash: 'a'.repeat(64),
            messageFactsJson: JSON.stringify({ type: 'deadline_reminder' }),
            quietWindowStartedAt: new Date('2026-07-10T09:00:00.000Z'),
            quietWindowEndsAt: new Date('2026-07-10T09:30:00.000Z'),
            scheduledFor: new Date('2026-07-10T09:00:00.000Z'),
          },
        });
      }
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    await prisma.integrationConnection.create({
      data: {
        id: 'reminder-scheduler-robot',
        type: 'dingtalk_robot',
        name: '调度验收机器人',
        credentialRef: 'vault:robot:reminder-scheduler',
        enabled: true,
        status: 'healthy',
        configJson: JSON.stringify({ quietWindowMinutes: 30 }),
      },
    });
    const prismaService = prisma as unknown as PrismaService;
    const registry = new JobRegistryService();
    const ledger = new WeeklyReportNotificationLedgerService(prismaService);
    scheduler = new WeeklyReportReminderSchedulerService(
      prismaService,
      { isHeld: true } as InstanceLeaseService,
      ledger,
      new AuditService(prismaService),
    );
    sendText = vi.fn().mockResolvedValue({
      requestId: 'reminder-provider-request',
      timestamp: 1,
      providerCallCount: 1,
      retryDelaysMs: [],
    });
    notificationHandler = new WeeklyReportNotificationHandler(
      registry,
      prismaService,
      { sendText } as unknown as DingTalkRobotClient,
      {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            webhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
            secret: 'SEC-test',
          }),
        ),
      } as unknown as CredentialVault,
    );
    notificationHandler.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('表重建迁移保留既有机器人通知的外键和冻结事实', async () => {
    expect(
      await prisma.robotNotification.findUniqueOrThrow({
        where: { id: 'reminder-upgrade-notification' },
      }),
    ).toMatchObject({
      reportId: 'reminder-upgrade-report',
      connectionId: 'reminder-upgrade-robot',
      notificationType: 'deadline_reminder',
      businessObjectKey: 'upgrade-preservation',
      contentHash: 'a'.repeat(64),
    });
    expect(
      await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA foreign_key_check'),
    ).toEqual([]);
  });

  it('休眠后仍在宽限内只补发一次，生成提醒允许没有周报外键', async () => {
    const policy = await seedPolicy({ graceMinutes: 120 });
    const resumedAt = new Date('2026-07-17T07:00:00.000Z'); // 上海周五 15:00，错过 14:00 一小时。

    await scheduler.reconcile(resumedAt);
    await scheduler.reconcile(resumedAt);

    const current = await prisma.weeklyReportReminderOccurrence.findFirstOrThrow({
      where: { policyId: policy.id, cycleKey: '2026-07-13:2026-07-17' },
    });
    expect(current).toMatchObject({
      reminderType: 'generation_reminder',
      status: 'queued',
      reportId: null,
      queuedAt: resumedAt,
    });
    expect(
      await prisma.weeklyReportReminderOccurrence.count({ where: { policyId: policy.id } }),
    ).toBe(9);
    expect(
      await prisma.robotNotification.count({ where: { connectionId: 'reminder-scheduler-robot' } }),
    ).toBe(1);
    expect(await prisma.job.count({ where: { payloadRef: current.notificationId } })).toBe(1);

    await execute(notificationHandler, current.notificationId!);
    expect(sendText).toHaveBeenCalledOnce();
    const sent = sendText.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain('Auto Work 周报生成提醒');
    expect(sent.text).toContain('不会自动生成或正式提交');
    expect(sent.text).not.toContain('localhost');
    expect(
      await prisma.weeklyReportReminderOccurrence.findUniqueOrThrow({ where: { id: current.id } }),
    ).toMatchObject({ status: 'succeeded', lastErrorCode: null });
  });

  it('休眠超过宽限记录 skipped，不创建发送作业也不调用机器人', async () => {
    const callsBefore = sendText.mock.calls.length;
    const policy = await seedPolicy({ graceMinutes: 60 });
    const resumedAt = new Date('2026-07-17T09:00:00.000Z'); // 上海周五 17:00，已超过两小时。

    await scheduler.reconcile(resumedAt);
    const current = await prisma.weeklyReportReminderOccurrence.findFirstOrThrow({
      where: { policyId: policy.id, cycleKey: '2026-07-13:2026-07-17' },
      include: { notification: true },
    });

    expect(current).toMatchObject({
      status: 'skipped',
      skipReason: 'MISSED_GRACE_WINDOW',
      jobId: null,
      notification: { status: 'skipped', skipReason: 'MISSED_GRACE_WINDOW' },
    });
    expect(await prisma.job.count({ where: { payloadRef: current.notificationId } })).toBe(0);
    expect(sendText).toHaveBeenCalledTimes(callsBefore);
  });

  it('策略停用会取消旧版本 queued occurrence、通知和作业', async () => {
    const policy = await seedPolicy({ graceMinutes: 120 });
    const resumedAt = new Date('2026-07-17T07:00:00.000Z');
    await scheduler.reconcile(resumedAt);
    const queued = await prisma.weeklyReportReminderOccurrence.findFirstOrThrow({
      where: { policyId: policy.id, cycleKey: '2026-07-13:2026-07-17' },
    });

    await prisma.weeklyReportReminderPolicy.update({
      where: { id: policy.id },
      data: { enabled: false, version: { increment: 1 } },
    });
    await scheduler.reconcile(new Date('2026-07-17T07:01:00.000Z'));

    expect(
      await prisma.weeklyReportReminderOccurrence.findUniqueOrThrow({ where: { id: queued.id } }),
    ).toMatchObject({ status: 'cancelled', skipReason: '提醒策略已停用或版本已变化' });
    expect(
      await prisma.robotNotification.findUniqueOrThrow({ where: { id: queued.notificationId! } }),
    ).toMatchObject({ status: 'cancelled' });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: queued.jobId! } })).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      lastErrorCode: 'WEEKLY_REMINDER_POLICY_CHANGED',
    });
  });

  it('已生成/已确认会跳过对应提醒，截止时仍按当前草稿状态排队', async () => {
    const callsBefore = sendText.mock.calls.length;
    const policy = await seedPolicy({ graceMinutes: 180, allReminders: true });
    await prisma.weeklyReport.create({
      data: {
        id: `reminder-report-${sequence}`,
        ownerProfileId: policy.profileId,
        periodStart: '2026-07-13',
        periodEnd: '2026-07-17',
        reportDate: '2026-07-17',
        timezone: 'Asia/Shanghai',
        status: 'confirmed',
      },
    });

    await scheduler.reconcile(new Date('2026-07-17T08:30:00.000Z')); // 上海 16:30。
    const current = await prisma.weeklyReportReminderOccurrence.findMany({
      where: { policyId: policy.id, cycleKey: '2026-07-13:2026-07-17' },
      orderBy: { scheduledFor: 'asc' },
    });
    expect(current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reminderType: 'generation_reminder',
          status: 'skipped',
          skipReason: 'REPORT_ALREADY_GENERATED',
        }),
        expect.objectContaining({
          reminderType: 'confirmation_reminder',
          status: 'skipped',
          skipReason: 'REPORT_ALREADY_CONFIRMED',
        }),
        expect.objectContaining({ reminderType: 'deadline_reminder', status: 'planned' }),
      ]),
    );

    await scheduler.reconcile(new Date('2026-07-17T09:45:00.000Z')); // 上海 17:45。
    const deadline = await prisma.weeklyReportReminderOccurrence.findFirstOrThrow({
      where: {
        policyId: policy.id,
        cycleKey: '2026-07-13:2026-07-17',
        reminderType: 'deadline_reminder',
      },
    });
    expect(deadline).toMatchObject({ status: 'queued', reportId: `reminder-report-${sequence}` });
    await execute(notificationHandler, deadline.notificationId!);
    expect(sendText).toHaveBeenCalledTimes(callsBefore + 1);
    expect((sendText.mock.calls.at(-1)![0] as { text: string }).text).toContain(
      '当前草稿状态：已确认待正式提交',
    );
  });

  async function seedPolicy(options: { graceMinutes: number; allReminders?: boolean }) {
    sequence += 1;
    const profileId = `reminder-profile-${sequence}`;
    await prisma.userProfile.create({
      data: {
        id: profileId,
        windowsSid: `S-1-5-21-reminder-${sequence}`,
        displayName: `提醒用户 ${sequence}`,
        timezone: 'Asia/Shanghai',
      },
    });
    return prisma.weeklyReportReminderPolicy.create({
      data: {
        id: `reminder-policy-${sequence}`,
        profileId,
        robotConnectionId: 'reminder-scheduler-robot',
        enabled: true,
        timezone: 'Asia/Shanghai',
        workingWeekdaysJson: '[1,2,3,4,5]',
        generationEnabled: true,
        generationWeekday: 5,
        generationTime: '14:00',
        confirmationEnabled: options.allReminders ?? false,
        confirmationWeekday: 5,
        confirmationTime: '16:00',
        deadlineEnabled: options.allReminders ?? false,
        deadlineWeekday: 5,
        deadlineTime: '17:30',
        graceMinutes: options.graceMinutes,
      },
    });
  }

  function execute(handler: JobHandler, notificationId: string) {
    return handler.execute({
      jobId: `job-for-${notificationId}`,
      payloadRef: notificationId,
      isCancellationRequested: () => Promise.resolve(false),
      reportProgress: () => Promise.resolve(),
    });
  }
});
