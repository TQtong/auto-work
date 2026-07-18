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
});
