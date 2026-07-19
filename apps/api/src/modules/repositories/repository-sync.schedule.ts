import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';

@Injectable()
export class RepositorySyncSchedule {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
  ) {}

  /**
   * 本地 Git 状态按详细设计每五分钟刷新一次。这里只排入只读作业，实际执行仍由
   * 持久化作业队列按“全局并发 2、逐仓库隔离失败”的规则恢复和推进。
   */
  @Cron('15 */5 * * * *', { timeZone: 'Asia/Shanghai' })
  public async enqueueScheduledRefresh(): Promise<void> {
    const repositoryCount = await this.prisma.repository.count({
      where: { whitelistStatus: { in: ['discovered', 'confirmed', 'needs_review'] } },
    });
    if (repositoryCount === 0) return;

    await this.queue.enqueue({
      type: 'repository.sync',
      payloadSummary: {
        scope: 'all',
        trigger: 'scheduled',
        repositoryCount,
      },
      priority: 115,
      maxAttempts: 2,
      // 固定去重键同时阻止手动“刷新全部”和定时刷新生成并发重复作业。
      dedupeKey: 'repository.sync:all',
    });
  }
}
