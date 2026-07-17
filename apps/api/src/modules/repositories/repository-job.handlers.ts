import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JobRegistryService, type JobExecutionContext } from '../jobs/job-registry.service.js';
import { RepositoryService } from './repository.service.js';

@Injectable()
export class RepositoryJobHandlers implements OnModuleInit {
  public constructor(
    private readonly registry: JobRegistryService,
    private readonly repositories: RepositoryService,
    private readonly prisma: PrismaService,
  ) {}

  public onModuleInit(): void {
    this.registry.register({
      type: 'repository.discover',
      concurrency: 1,
      recovery: 'safe_replay',
      execute: (context) => this.discover(context),
    });
    this.registry.register({
      type: 'repository.sync',
      concurrency: 2,
      recovery: 'safe_replay',
      execute: (context) => this.sync(context),
    });
  }

  private async discover(context: JobExecutionContext) {
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: context.jobId } });
    const summary = JSON.parse(job.payloadSummary) as { includeMissingCheck?: boolean };
    await context.reportProgress(10);
    const result = await this.repositories.discover(summary.includeMissingCheck !== false);
    await context.reportProgress(100);
    return result;
  }

  private async sync(context: JobExecutionContext) {
    const ids = context.payloadRef
      ? [context.payloadRef]
      : (
          await this.prisma.repository.findMany({
            where: { whitelistStatus: { in: ['discovered', 'confirmed', 'needs_review'] } },
            select: { id: true },
          })
        ).map((row) => row.id);
    const results: Array<{ repositoryId: string; status: string; error?: string }> = [];
    for (const [index, id] of ids.entries()) {
      if (await context.isCancellationRequested()) break;
      try {
        await this.repositories.refresh(id);
        results.push({ repositoryId: id, status: 'succeeded' });
      } catch (error) {
        results.push({ repositoryId: id, status: 'failed', error: (error as Error).message });
      }
      await context.reportProgress(Math.round(((index + 1) / Math.max(ids.length, 1)) * 100));
    }
    return { total: ids.length, results };
  }
}
