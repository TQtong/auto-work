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
    type RepositorySyncResult = { repositoryId: string; status: string; error?: string };
    const results = Array.from(
      { length: ids.length },
      (): RepositorySyncResult | undefined => undefined,
    );
    let nextIndex = 0;
    let completedCount = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        // 每次领取下一仓库前重新读取持久化取消标记；已经开始的只读 Git 命令允许自然结束。
        if (await context.isCancellationRequested()) return;
        const index = nextIndex;
        if (index >= ids.length) return;
        nextIndex += 1;
        const id = ids[index]!;
        try {
          await this.repositories.refresh(id);
          results[index] = { repositoryId: id, status: 'succeeded' };
        } catch (error) {
          // 单仓库失败只写入本项结果，不取消其余仓库，也不伪造整体成功。
          results[index] = {
            repositoryId: id,
            status: 'failed',
            error: (error as Error).message,
          };
        }
        completedCount += 1;
        await context.reportProgress(Math.round((completedCount / Math.max(ids.length, 1)) * 100));
      }
    };

    // 详细设计规定本地状态刷新全局并发为 2，避免 14 个仓库串行阻塞或同时打满磁盘。
    await Promise.all(Array.from({ length: Math.min(2, ids.length) }, () => worker()));
    const completedResults = results.filter(
      (result): result is NonNullable<(typeof results)[number]> => result !== undefined,
    );
    return {
      total: ids.length,
      processed: completedResults.length,
      cancelled: completedResults.length < ids.length,
      results: completedResults,
    };
  }
}
