import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';

@Injectable()
export class GitLabSyncSchedule {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
  ) {}

  /** 读取任务可自动调度；持久化去重键保证同一连接不会并发重复同步。 */
  @Cron('0 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  public async enqueueDueConnections(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: {
        type: 'gitlab',
        enabled: true,
        credentialRef: { not: null },
        status: { in: ['healthy', 'degraded'] },
      },
      select: { id: true },
    });
    for (const connection of connections) {
      await this.queue.enqueue({
        type: 'gitlab.sync',
        payloadRef: connection.id,
        payloadSummary: { connectionId: connection.id, trigger: 'scheduled' },
        priority: 110,
        maxAttempts: 3,
        dedupeKey: `gitlab.sync:${connection.id}`,
      });
    }
  }
}
