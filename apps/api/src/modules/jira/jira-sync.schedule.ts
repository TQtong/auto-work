import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';

@Injectable()
export class JiraSyncSchedule {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
  ) {}

  /** Jira 增量同步是只读安全作业；复合水位和重叠窗口让崩溃重放保持幂等。 */
  @Cron('30 */5 * * * *', { timeZone: 'Asia/Shanghai' })
  public async enqueueDueConnections(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: {
        type: 'jira',
        enabled: true,
        credentialRef: { not: null },
        status: { in: ['healthy', 'degraded'] },
      },
      select: { id: true },
    });
    for (const connection of connections) {
      const dedupeKey = `jira.sync:${connection.id}:incremental`;
      const active = await this.prisma.job.findFirst({
        where: { dedupeKey, status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (active) continue;
      const mapping = await this.prisma.fieldMappingVersion.findFirst({
        where: { connectionId: connection.id },
        orderBy: { versionNo: 'desc' },
        select: { id: true },
      });
      if (!mapping) continue;
      const request = { scope: 'incremental' as const };
      const run = await this.prisma.jiraSyncRun.create({
        data: {
          id: newId(),
          connectionId: connection.id,
          scope: request.scope,
          trigger: 'scheduled',
          status: 'queued',
          mappingVersionId: mapping.id,
          queryHash: requestHash(request),
          requestJson: JSON.stringify(request),
          startedAt: new Date(),
        },
      });
      await this.queue.enqueue({
        type: 'jira.sync',
        payloadRef: run.id,
        payloadSummary: { connectionId: connection.id, scope: request.scope, runId: run.id },
        priority: 105,
        maxAttempts: 3,
        dedupeKey,
      });
    }
  }
}
