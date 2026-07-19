import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { JobHandler, JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import { RepositoryJobHandlers } from '../src/modules/repositories/repository-job.handlers.js';
import type { RepositoryService } from '../src/modules/repositories/repository.service.js';

describe('本地仓库刷新作业执行器', () => {
  it('以并发上限 2 隔离单仓库失败，并按原始仓库顺序返回结果', async () => {
    let registered: JobHandler | undefined;
    let active = 0;
    let maximumActive = 0;
    const refresh = vi.fn(async (id: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, id === 'repo-1' ? 20 : 5),
      );
      active -= 1;
      if (id === 'repo-2') throw new Error('仓库不可读取');
    });
    const handlers = new RepositoryJobHandlers(
      {
        register: vi.fn((definition: JobHandler) => {
          if (definition.type === 'repository.sync') registered = definition;
        }),
      } as unknown as JobRegistryService,
      { refresh } as unknown as RepositoryService,
      {
        job: { findUniqueOrThrow: vi.fn().mockResolvedValue({ payloadSummary: '{}' }) },
        repository: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 'repo-1' }, { id: 'repo-2' }, { id: 'repo-3' }]),
        },
      } as unknown as PrismaService,
    );
    handlers.onModuleInit();
    const reportProgress = vi.fn().mockResolvedValue(undefined);

    if (!registered) throw new Error('repository.sync 处理器未注册');
    const result = await registered.execute({
      jobId: 'job-1',
      payloadRef: null,
      reportProgress,
      isCancellationRequested: vi.fn().mockResolvedValue(false),
    });

    expect(maximumActive).toBe(2);
    expect(result).toEqual({
      total: 3,
      processed: 3,
      cancelled: false,
      results: [
        { repositoryId: 'repo-1', status: 'succeeded' },
        { repositoryId: 'repo-2', status: 'failed', error: '仓库不可读取' },
        { repositoryId: 'repo-3', status: 'succeeded' },
      ],
    });
    expect(reportProgress).toHaveBeenCalledTimes(3);
    expect(reportProgress).toHaveBeenLastCalledWith(100);
  });

  it('取消后不再领取新仓库并明确返回部分完成状态', async () => {
    let registered: JobHandler | undefined;
    const handlers = new RepositoryJobHandlers(
      {
        register: vi.fn((definition: JobHandler) => {
          if (definition.type === 'repository.sync') registered = definition;
        }),
      } as unknown as JobRegistryService,
      { refresh: vi.fn() } as unknown as RepositoryService,
      {
        job: { findUniqueOrThrow: vi.fn().mockResolvedValue({ payloadSummary: '{}' }) },
        repository: { findMany: vi.fn().mockResolvedValue([{ id: 'repo-1' }, { id: 'repo-2' }]) },
      } as unknown as PrismaService,
    );
    handlers.onModuleInit();

    if (!registered) throw new Error('repository.sync 处理器未注册');
    await expect(
      registered.execute({
        jobId: 'job-cancelled',
        payloadRef: null,
        reportProgress: vi.fn(),
        isCancellationRequested: vi.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({ total: 2, processed: 0, cancelled: true, results: [] });
  });
});
