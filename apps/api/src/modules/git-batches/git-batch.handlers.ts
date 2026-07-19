import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import type { GitBatchItem } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobRegistryService, type JobExecutionContext } from '../jobs/job-registry.service.js';
import { GitBatchEngineService } from './git-batch-engine.service.js';
import { GitBatchService } from './git-batch.service.js';
import type { GitExecutionResult } from './git-batch.types.js';
import { RepositoryWriteLockService } from './repository-write-lock.service.js';

@Injectable()
export class GitBatchHandlers implements OnModuleInit {
  public constructor(
    private readonly registry: JobRegistryService,
    private readonly prisma: PrismaService,
    private readonly batches: GitBatchService,
    private readonly engine: GitBatchEngineService,
    private readonly locks: RepositoryWriteLockService,
    private readonly audit: AuditService,
  ) {}

  public onModuleInit(): void {
    this.registry.register({
      type: 'git.batch.preview',
      concurrency: 2,
      recovery: 'safe_replay',
      execute: (context) => this.preview(context),
    });
    // 写动作崩溃后绝不能自动重放，因为无法证明前一次命令是否已经生效。
    this.registry.register({
      type: 'git.batch.execute',
      concurrency: 1,
      recovery: 'manual_review',
      execute: (context) => this.execute(context),
    });
  }

  private async preview(context: JobExecutionContext) {
    if (!context.payloadRef) throw new DomainError('GIT_BATCH_ID_MISSING', '预览作业缺少批次 ID');
    const batch = await this.prisma.gitBatch.findUnique({
      where: { id: context.payloadRef },
      include: { items: { include: { repository: true }, orderBy: { ordinal: 'asc' } } },
    });
    if (!batch) throw new DomainError('GIT_BATCH_NOT_FOUND', 'Git 批次不存在', { httpStatus: 404 });
    if (batch.status === 'cancelled') return { batchId: batch.id, status: 'cancelled' };
    if (!['previewing', 'preview_failed'].includes(batch.status)) {
      return { batchId: batch.id, status: batch.status };
    }
    const parameters = this.batches.parseParameters(batch);
    let previewed = 0;
    let blocked = 0;
    let snapshots = 0;
    for (const [index, item] of batch.items.entries()) {
      if (await context.isCancellationRequested()) break;
      await this.transition(item, 'previewing', 2, context.jobId);
      try {
        const preview = await this.engine.preview(item.repository, batch.action, parameters);
        const status = preview.executable ? 'previewed' : 'blocked';
        await this.prisma.$transaction([
          this.prisma.gitBatchItem.update({
            where: { id: item.id },
            data: {
              status,
              previewSnapshotJson: JSON.stringify({
                ...preview.snapshot,
                alreadySatisfied: preview.alreadySatisfied,
              }),
              previewSnapshotHash: preview.snapshotHash,
              displayCommand: preview.displayCommand,
              expectedChangesJson: JSON.stringify(preview.expectedChanges),
              warningsJson: JSON.stringify(preview.warnings),
              blockingReasonsJson: JSON.stringify(preview.blockingReasons),
              riskLevel: preview.riskLevel,
              executable: preview.executable,
            },
          }),
          this.prisma.gitOperationEvent.upsert({
            where: { batchItemId_sequence: { batchItemId: item.id, sequence: 3 } },
            create: {
              id: newId(),
              batchItemId: item.id,
              sequence: 3,
              fromStatus: 'previewing',
              toStatus: status,
              workerRequestId: context.jobId,
            },
            update: {},
          }),
        ]);
        snapshots += 1;
        if (preview.executable) previewed += 1;
        else blocked += 1;
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'GIT_PREVIEW_FAILED';
        const message = this.safeError(error);
        await this.prisma.$transaction([
          this.prisma.gitBatchItem.update({
            where: { id: item.id },
            data: {
              status: 'blocked',
              executable: false,
              blockingReasonsJson: JSON.stringify([
                { code, message, recovery: '修复仓库状态或配置后重新创建预览' },
              ]),
            },
          }),
          this.prisma.gitOperationEvent.upsert({
            where: { batchItemId_sequence: { batchItemId: item.id, sequence: 3 } },
            create: {
              id: newId(),
              batchItemId: item.id,
              sequence: 3,
              fromStatus: 'previewing',
              toStatus: 'blocked',
              workerRequestId: context.jobId,
              errorCode: code,
            },
            update: {},
          }),
        ]);
        blocked += 1;
      }
      await context.reportProgress(
        Math.round(((index + 1) / Math.max(batch.items.length, 1)) * 90),
      );
    }

    const latest = await this.prisma.gitBatch.findUnique({ where: { id: batch.id } });
    if (!latest || latest.status === 'cancelled') return { batchId: batch.id, status: 'cancelled' };
    const items = await this.prisma.gitBatchItem.findMany({
      where: { batchId: batch.id },
      orderBy: { ordinal: 'asc' },
    });
    const previewHash = requestHash({
      batchId: batch.id,
      action: batch.action,
      parameters,
      items: items.map((item) => ({
        id: item.id,
        repositoryId: item.repositoryId,
        hash: item.previewSnapshotHash,
        executable: item.executable,
        blocks: item.blockingReasonsJson,
      })),
    });
    const previewedAt = new Date();
    const status = snapshots === 0 ? 'preview_failed' : 'previewed';
    await this.prisma.gitBatch.updateMany({
      where: { id: batch.id, status: { in: ['previewing', 'preview_failed'] } },
      data: {
        status,
        previewHash,
        previewedAt,
        expiresAt: new Date(previewedAt.getTime() + 10 * 60 * 1_000),
        summaryJson: JSON.stringify({ total: items.length, previewed, blocked }),
        version: { increment: 1 },
      },
    });
    await context.reportProgress(100);
    return { batchId: batch.id, status, previewed, blocked };
  }

  private async execute(context: JobExecutionContext) {
    if (!context.payloadRef) throw new DomainError('GIT_BATCH_ID_MISSING', '执行作业缺少批次 ID');
    const now = new Date();
    const claimed = await this.prisma.gitBatch.updateMany({
      where: { id: context.payloadRef, status: 'approved', executionStartedAt: null },
      data: { status: 'running', executionStartedAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      const existing = await this.prisma.gitBatch.findUnique({ where: { id: context.payloadRef } });
      if (
        existing &&
        ['completed', 'partial_failed', 'failed', 'needs_review'].includes(existing.status)
      ) {
        return { batchId: existing.id, status: existing.status };
      }
      throw new DomainError('GIT_BATCH_STATE_CONFLICT', 'Git 批次不处于可执行状态', {
        httpStatus: 409,
      });
    }
    const batch = await this.prisma.gitBatch.findUniqueOrThrow({
      where: { id: context.payloadRef },
      include: {
        items: {
          where: { selected: true },
          include: { repository: true },
          orderBy: { ordinal: 'asc' },
        },
      },
    });
    const parameters = this.batches.parseParameters(batch);
    for (const [index, item] of batch.items.entries()) {
      const release = await this.locks.acquire(item.repositoryId);
      try {
        await this.setRunning(item, context.jobId);
        let result: GitExecutionResult;
        try {
          if (!item.previewSnapshotHash) {
            result = this.failure('stale_preview', '预览快照缺失，未执行写操作');
          } else {
            result = await this.engine.execute(
              item.repository,
              batch.action,
              parameters,
              item.previewSnapshotHash,
            );
          }
        } catch (error) {
          const stale =
            error instanceof DomainError &&
            ['REPOSITORY_IDENTITY_CHANGED', 'REPOSITORY_NOT_CONFIRMED'].includes(error.code);
          result = this.failure(stale ? 'stale_preview' : 'failed', this.safeError(error));
        }
        await this.finishItem(batch, item, result, context.jobId);
      } finally {
        release();
      }
      await context.reportProgress(
        Math.round(((index + 1) / Math.max(batch.items.length, 1)) * 95),
      );
    }

    const results = await this.prisma.gitBatchItem.findMany({ where: { batchId: batch.id } });
    const counts = results.reduce<Record<string, number>>((accumulator, item) => {
      const key = item.resultCode ?? item.status;
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
    const successCount = (counts.succeeded ?? 0) + (counts.already_satisfied ?? 0);
    const adverseCount = (counts.failed ?? 0) + (counts.stale_preview ?? 0) + (counts.blocked ?? 0);
    const finalStatus =
      (counts.needs_review ?? 0) > 0
        ? 'needs_review'
        : adverseCount > 0 && successCount > 0
          ? 'partial_failed'
          : adverseCount > 0
            ? 'failed'
            : 'completed';
    await this.prisma.gitBatch.update({
      where: { id: batch.id },
      data: {
        status: finalStatus,
        executionEndedAt: new Date(),
        summaryJson: JSON.stringify({ total: results.length, ...counts }),
        version: { increment: 1 },
      },
    });
    await context.reportProgress(100);
    return { batchId: batch.id, status: finalStatus, counts };
  }

  private async transition(
    item: GitBatchItem,
    toStatus: string,
    sequence: number,
    workerRequestId: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.gitBatchItem.update({ where: { id: item.id }, data: { status: toStatus } }),
      this.prisma.gitOperationEvent.upsert({
        where: { batchItemId_sequence: { batchItemId: item.id, sequence } },
        create: {
          id: newId(),
          batchItemId: item.id,
          sequence,
          fromStatus: item.status,
          toStatus,
          workerRequestId,
        },
        update: {},
      }),
    ]);
  }

  private async setRunning(item: GitBatchItem, workerRequestId: string) {
    const sequence =
      (await this.prisma.gitOperationEvent.count({ where: { batchItemId: item.id } })) + 1;
    await this.prisma.$transaction([
      this.prisma.gitBatchItem.update({
        where: { id: item.id },
        data: {
          status: 'running',
          startedAt: new Date(),
          executionCheckJson: JSON.stringify({
            expectedSnapshotHash: item.previewSnapshotHash,
            checkedAt: new Date().toISOString(),
          }),
        },
      }),
      this.prisma.gitOperationEvent.create({
        data: {
          id: newId(),
          batchItemId: item.id,
          sequence,
          fromStatus: item.status,
          toStatus: 'running',
          workerRequestId,
        },
      }),
    ]);
  }

  private async finishItem(
    batch: {
      id: string;
      action: string;
      approvedBy: string | null;
      approvalRequestHash: string | null;
    },
    item: GitBatchItem,
    result: GitExecutionResult,
    workerRequestId: string,
  ) {
    const auditEventId = await this.audit.record({
      actorType: 'local_user',
      actorId: batch.approvedBy ?? 'unknown-local-user',
      action: `git.${batch.action}`,
      targetType: 'repository',
      targetId: item.repositoryId,
      correlationId: workerRequestId,
      ...(batch.approvalRequestHash ? { approvalId: batch.approvalRequestHash } : {}),
      outcome:
        result.resultCode === 'succeeded' || result.resultCode === 'already_satisfied'
          ? 'succeeded'
          : result.resultCode === 'needs_review'
            ? 'unknown'
            : 'failed',
      before: { previewSnapshotHash: item.previewSnapshotHash },
      after: { resultCode: result.resultCode, postHeadSha: result.postHeadSha },
      clientSessionHash: requestHash({ source: 'git-batch-worker', batchId: batch.id }),
      ...(result.resultCode === 'failed' || result.resultCode === 'needs_review'
        ? { errorCode: result.resultCode }
        : {}),
    });
    const sequence =
      (await this.prisma.gitOperationEvent.count({ where: { batchItemId: item.id } })) + 1;
    await this.prisma.$transaction([
      this.prisma.gitBatchItem.update({
        where: { id: item.id },
        data: {
          status: result.resultCode,
          resultCode: result.resultCode,
          resultSummary: result.summary,
          exitCode: result.exitCode,
          postHeadSha: result.postHeadSha,
          outputSummary: result.outputSummary,
          durationMs: result.durationMs,
          completedAt: new Date(),
        },
      }),
      this.prisma.gitOperationEvent.create({
        data: {
          id: newId(),
          batchItemId: item.id,
          sequence,
          fromStatus: 'running',
          toStatus: result.resultCode,
          workerRequestId,
          auditEventId,
          ...(result.resultCode === 'failed' || result.resultCode === 'needs_review'
            ? { errorCode: result.resultCode }
            : {}),
        },
      }),
    ]);
  }

  private failure(resultCode: 'failed' | 'stale_preview', summary: string): GitExecutionResult {
    return {
      resultCode,
      summary,
      exitCode: null,
      postHeadSha: null,
      outputSummary: '',
      durationMs: 0,
    };
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : '未知 Git 批次错误')
      .replace(/(?:Bearer|PRIVATE-TOKEN|token|secret|password)\s*[:=]?\s*\S+/giu, '[REDACTED]')
      .slice(0, 1_000);
  }
}
