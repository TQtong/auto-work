import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@auto-work/contracts';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { InstanceLeaseService } from '../src/modules/jobs/instance-lease.service.js';
import type { JobHandler } from '../src/modules/jobs/job-registry.service.js';
import type { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import { JobRunnerService } from '../src/modules/jobs/job-runner.service.js';

describe('持久化作业重试分类', () => {
  it.each([
    [false, 'failed', 'NON_RETRYABLE'],
    [true, 'queued', 'JOB_ATTEMPT_FAILED'],
  ] as const)('DomainError retryable=%s 时进入 %s', async (retryable, status, errorCode) => {
    const update = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<Record<string, never>>>()
      .mockResolvedValue({});
    const job = {
      id: 'job-1',
      payloadRef: null,
      attemptCount: 1,
      maxAttempts: 3,
      cancelRequested: false,
    };
    const prisma = {
      job: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(job),
        findUnique: vi.fn().mockResolvedValue(job),
        update,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const runner = new JobRunnerService(
      prisma,
      {} as JobRegistryService,
      {} as InstanceLeaseService,
    );
    const handler: JobHandler = {
      type: 'test',
      concurrency: 1,
      recovery: 'safe_replay',
      execute: vi
        .fn()
        .mockRejectedValue(new DomainError('NON_RETRYABLE', '测试错误', { retryable })),
    };
    const execute = (
      runner as unknown as {
        execute(jobId: string, target: JobHandler): Promise<void>;
      }
    ).execute.bind(runner);

    await execute.call(runner, job.id, handler);
    expect(update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status,
      lastErrorCode: errorCode,
    });
  });

  it('含外部副作用的人工复核作业即使达到最大次数也进入 unknown 而不标记可重放失败', async () => {
    const update = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<Record<string, never>>>()
      .mockResolvedValue({});
    const job = {
      id: 'manual-review-job',
      payloadRef: null,
      attemptCount: 1,
      maxAttempts: 1,
      cancelRequested: false,
    };
    const prisma = {
      job: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(job),
        findUnique: vi.fn().mockResolvedValue(job),
        update,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const runner = new JobRunnerService(
      prisma,
      {} as JobRegistryService,
      {} as InstanceLeaseService,
    );
    const handler: JobHandler = {
      type: 'integration.test',
      concurrency: 1,
      recovery: 'manual_review',
      execute: vi.fn().mockRejectedValue(new Error('发送后状态未知')),
    };
    const execute = (
      runner as unknown as {
        execute(jobId: string, target: JobHandler): Promise<void>;
      }
    ).execute.bind(runner);

    await execute.call(runner, job.id, handler);
    expect(update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'unknown',
      lastErrorCode: 'RESULT_REQUIRES_REVIEW',
    });
  });

  it('启动恢复会把租约过期的通知和钉钉交付业务事实一并转为 unknown', async () => {
    const notificationUpdate = vi
      .fn<
        (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>
      >()
      .mockResolvedValue({ count: 1 });
    const intentUpdate = vi
      .fn<
        (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>
      >()
      .mockResolvedValue({ count: 1 });
    const reportUpdate = vi
      .fn<
        (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<Record<string, never>>
      >()
      .mockResolvedValue({});
    const occurrenceUpdate = vi
      .fn<
        (input: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>
      >()
      .mockResolvedValue({ count: 1 });
    const expiredJobs = [
      { id: 'notification-job', type: 'weekly-report.notification', payloadRef: 'notice-1' },
      { id: 'delivery-job', type: 'weekly-report.delivery', payloadRef: 'intent-1' },
    ];
    const prisma = {
      job: {
        findMany: vi.fn().mockResolvedValue(expiredJobs),
        update: vi.fn().mockResolvedValue({}),
      },
      robotNotification: { updateMany: notificationUpdate },
      deliveryIntent: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'intent-1',
          reportId: 'report-1',
          channel: 'dingtalk_log',
          status: 'running',
          version: 4,
        }),
      },
      $transaction: vi.fn((callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
        callback({
          deliveryIntent: { updateMany: intentUpdate },
          weeklyReport: { update: reportUpdate },
          robotNotification: { updateMany: notificationUpdate },
          weeklyReportReminderOccurrence: { updateMany: occurrenceUpdate },
        }),
      ),
    } as unknown as PrismaService;
    const registry = {
      recoveryFor: vi.fn().mockReturnValue('manual_review'),
    } as unknown as JobRegistryService;
    const runner = new JobRunnerService(prisma, registry, {} as InstanceLeaseService);

    await runner.onApplicationBootstrap();

    expect(notificationUpdate.mock.calls[0]?.[0].where).toEqual({
      id: 'notice-1',
      status: 'sending',
    });
    expect(notificationUpdate.mock.calls[0]?.[0].data).toMatchObject({ status: 'unknown' });
    expect(occurrenceUpdate.mock.calls[0]?.[0]).toMatchObject({
      where: { notificationId: 'notice-1', status: 'queued' },
      data: { status: 'unknown', lastErrorCode: 'RESULT_REQUIRES_REVIEW' },
    });
    expect(intentUpdate.mock.calls[0]?.[0].where).toEqual({
      id: 'intent-1',
      status: 'running',
      version: 4,
    });
    expect(intentUpdate.mock.calls[0]?.[0].data).toMatchObject({
      status: 'unknown',
      recoveryStatus: 'pending',
    });
    expect(reportUpdate.mock.calls[0]?.[0].data).toMatchObject({
      logDeliveryState: 'unknown',
    });
  });
});
