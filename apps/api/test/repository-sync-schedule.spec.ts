import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { JobQueueService } from '../src/modules/jobs/job-queue.service.js';
import { RepositorySyncSchedule } from '../src/modules/repositories/repository-sync.schedule.js';

describe('本地仓库元数据定时刷新', () => {
  it('存在可刷新仓库时排入可恢复且全局去重的只读作业', async () => {
    const count = vi.fn().mockResolvedValue(14);
    const enqueue = vi.fn().mockResolvedValue({ id: 'repository-sync-job' });
    const schedule = new RepositorySyncSchedule(
      { repository: { count } } as unknown as PrismaService,
      { enqueue } as unknown as JobQueueService,
    );

    await schedule.enqueueScheduledRefresh();

    expect(count).toHaveBeenCalledWith({
      where: { whitelistStatus: { in: ['discovered', 'confirmed', 'needs_review'] } },
    });
    expect(enqueue).toHaveBeenCalledWith({
      type: 'repository.sync',
      payloadSummary: { scope: 'all', trigger: 'scheduled', repositoryCount: 14 },
      priority: 115,
      maxAttempts: 2,
      dedupeKey: 'repository.sync:all',
    });
  });

  it('没有已登记仓库时不制造空作业', async () => {
    const enqueue = vi.fn();
    const schedule = new RepositorySyncSchedule(
      { repository: { count: vi.fn().mockResolvedValue(0) } } as unknown as PrismaService,
      { enqueue } as unknown as JobQueueService,
    );

    await schedule.enqueueScheduledRefresh();

    expect(enqueue).not.toHaveBeenCalled();
  });
});
