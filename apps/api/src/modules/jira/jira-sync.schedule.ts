import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';

@Injectable()
export class JiraSyncSchedule implements OnApplicationBootstrap {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.enqueueRecoveryConnections();
  }

  /** 每日只读增量同步；启动时只修复旧版遗留的“需配置”连接，不额外拉取任务。 */
  @Cron('0 0 6 * * *', { timeZone: 'Asia/Shanghai' })
  public async enqueueDueConnections(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: {
        type: 'jira',
        enabled: true,
        credentialRef: { not: null },
        status: { in: ['healthy', 'degraded', 'configuration_required'] },
      },
      select: { id: true, credentialRef: true, configJson: true },
    });
    for (const connection of connections) {
      const mapping = await this.prisma.fieldMappingVersion.findFirst({
        where: { connectionId: connection.id },
        orderBy: { versionNo: 'desc' },
        select: { id: true },
      });
      if (!mapping) {
        await this.queue.enqueue({
          type: 'integration.test',
          payloadRef: connection.id,
          payloadSummary: {
            integrationType: 'jira',
            integrationId: connection.id,
            automatic: true,
            reason: 'bootstrap_or_daily_recovery',
          },
          maxAttempts: 2,
          dedupeKey: `integration.test:${connection.id}:${requestHash({
            credentialRef: connection.credentialRef,
            configJson: connection.configJson,
          })}`,
        });
        continue;
      }
      const dedupeKey = `jira.sync:${connection.id}:incremental`;
      const active = await this.prisma.job.findFirst({
        where: { dedupeKey, status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (active) continue;
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

  private async enqueueRecoveryConnections(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: {
        type: 'jira',
        enabled: true,
        credentialRef: { not: null },
        status: 'configuration_required',
      },
      select: { id: true, credentialRef: true, configJson: true },
    });
    for (const connection of connections) {
      await this.queue.enqueue({
        type: 'integration.test',
        payloadRef: connection.id,
        payloadSummary: {
          integrationType: 'jira',
          integrationId: connection.id,
          automatic: true,
          reason: 'bootstrap_recovery',
        },
        maxAttempts: 2,
        dedupeKey: `integration.test:${connection.id}:${requestHash({
          credentialRef: connection.credentialRef,
          configJson: connection.configJson,
        })}`,
      });
    }
  }
}
