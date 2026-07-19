import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes, type GitBatchWarning } from '@auto-work/contracts';
import { newId, requestHash, stableJson } from '@auto-work/domain';
import type { GitBatch, GitBatchItem, Repository } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { ApproveGitBatchInput, PreviewGitBatchInput } from './git-batch.schemas.js';

type BatchWithItems = GitBatch & {
  items: Array<GitBatchItem & { repository: Repository }>;
};

@Injectable()
export class GitBatchService {
  public constructor(private readonly prisma: PrismaService) {}

  public async createPreview(input: PreviewGitBatchInput, actorId: string) {
    const repositoryIds = [...new Set(input.repositoryIds)].sort();
    const repositories = await this.prisma.repository.findMany({
      where: { id: { in: repositoryIds } },
      orderBy: { id: 'asc' },
    });
    if (repositories.length !== repositoryIds.length) {
      throw new DomainError(errorCodes.notFound, '至少一个仓库不存在', { httpStatus: 404 });
    }
    const notConfirmed = repositories.filter((item) => item.whitelistStatus !== 'confirmed');
    if (notConfirmed.length > 0) {
      throw new DomainError(
        'REPOSITORY_NOT_CONFIRMED',
        '只有用户已确认的白名单仓库才能加入 Git 批次',
        {
          httpStatus: 409,
          details: { repositoryIds: notConfirmed.map((item) => item.id) },
        },
      );
    }

    const batchId = newId();
    const jobId = newId();
    const parametersJson = stableJson(input.parameters);
    await this.prisma.$transaction([
      this.prisma.gitBatch.create({
        data: {
          id: batchId,
          action: input.action,
          parametersJson,
          status: 'previewing',
          createdBy: actorId,
          summaryJson: JSON.stringify({ total: repositoryIds.length, previewed: 0, blocked: 0 }),
          items: {
            create: repositories.map((repository, ordinal) => ({
              id: newId(),
              repositoryId: repository.id,
              ordinal,
              status: 'queued',
              events: { create: { id: newId(), sequence: 1, toStatus: 'queued' } },
            })),
          },
        },
      }),
      this.prisma.job.create({
        data: {
          id: jobId,
          type: 'git.batch.preview',
          payloadRef: batchId,
          payloadSummary: JSON.stringify({
            batchId,
            action: input.action,
            repositoryCount: repositoryIds.length,
          }),
          priority: 15,
          scheduledAt: new Date(),
          maxAttempts: 2,
          dedupeKey: `git.batch.preview:${batchId}`,
        },
      }),
    ]);
    return {
      batchId,
      operationId: jobId,
      status: 'previewing',
      batchUrl: `/api/v1/git/batches/${batchId}`,
      statusUrl: `/api/v1/operations/${jobId}`,
    };
  }

  public async get(batchId: string) {
    let batch = await this.load(batchId);
    if (batch.status === 'previewed' && batch.expiresAt && batch.expiresAt <= new Date()) {
      await this.prisma.gitBatch.updateMany({
        where: { id: batch.id, status: 'previewed', version: batch.version },
        data: { status: 'expired', version: { increment: 1 } },
      });
      batch = await this.load(batchId);
    }
    return this.toView(batch);
  }

  public async list(limit = 20) {
    const batches = await this.prisma.gitBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(50, limit)),
      select: {
        id: true,
        action: true,
        status: true,
        version: true,
        expiresAt: true,
        summaryJson: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return batches.map((batch) => ({
      ...batch,
      expiresAt: batch.expiresAt?.toISOString() ?? null,
      summary: this.parseJson(batch.summaryJson, {}),
      summaryJson: undefined,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
    }));
  }

  public async approve(batchId: string, input: ApproveGitBatchInput, actorId: string) {
    const batch = await this.load(batchId);
    if (batch.status !== 'previewed') {
      throw new DomainError('GIT_BATCH_STATE_CONFLICT', '只有已完成预览的批次可以批准', {
        httpStatus: 409,
      });
    }
    if (!batch.expiresAt || batch.expiresAt <= new Date()) {
      await this.prisma.gitBatch.updateMany({
        where: { id: batch.id, status: 'previewed' },
        data: { status: 'expired', version: { increment: 1 } },
      });
      throw new DomainError('GIT_BATCH_EXPIRED', '预览已过期，请重新创建预览', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    if (batch.version !== input.batchVersion || !batch.previewHash) {
      throw new DomainError('GIT_PREVIEW_STALE', '批次版本或预览哈希已变化', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    const selectedIds = [...new Set(input.selectedItemIds)].sort();
    const selected = batch.items.filter((item) => selectedIds.includes(item.id));
    if (selected.length !== selectedIds.length || selected.some((item) => !item.executable)) {
      throw new DomainError('GIT_ITEM_NOT_EXECUTABLE', '选择中包含不存在或被阻断的仓库条目', {
        httpStatus: 422,
      });
    }
    const requiredWarnings = selected.flatMap((item) =>
      this.parseJson<GitBatchWarning[]>(item.warningsJson, [])
        .filter((warning) => warning.severity === 'warning')
        .map((warning) => `${item.id}:${warning.id}`),
    );
    const acknowledged = new Set(input.acknowledgedWarningIds);
    const missingWarnings = requiredWarnings.filter((id) => !acknowledged.has(id));
    if (missingWarnings.length > 0) {
      throw new DomainError('GIT_WARNING_NOT_ACKNOWLEDGED', '必须逐项确认所有警告后才能批准', {
        httpStatus: 422,
        details: { warningIds: missingWarnings },
      });
    }
    const sensitive = ['commit', 'push', 'push_set_upstream'].includes(batch.action);
    if (
      (sensitive && input.confirmation !== '确认执行') ||
      (!sensitive && input.confirmation !== true && input.confirmation !== '确认执行')
    ) {
      throw new DomainError(
        'GIT_CONFIRMATION_REQUIRED',
        sensitive ? '提交或推送必须输入确认短语“确认执行”' : '必须明确确认本批次',
        { httpStatus: 422 },
      );
    }

    const approvalHash = requestHash({
      batchId,
      batchVersion: input.batchVersion,
      previewHash: batch.previewHash,
      selectedItemIds: selectedIds,
      acknowledgedWarningIds: [...acknowledged].sort(),
      confirmation: input.confirmation,
    });
    const jobId = newId();
    const approvedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.gitBatch.updateMany({
        where: { id: batch.id, status: 'previewed', version: input.batchVersion },
        data: {
          status: 'approved',
          approvedBy: actorId,
          approvedAt,
          approvalRequestHash: approvalHash,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        throw new DomainError('GIT_PREVIEW_STALE', '批次在批准期间已变化', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }
      await transaction.gitBatchItem.updateMany({
        where: { batchId, id: { in: selectedIds } },
        data: { selected: true, status: 'queued' },
      });
      await transaction.gitBatchItem.updateMany({
        where: { batchId, id: { notIn: selectedIds } },
        data: {
          selected: false,
          status: 'skipped_by_user',
          resultCode: 'skipped_by_user',
          resultSummary: '用户在审批时未选择此仓库',
          completedAt: approvedAt,
        },
      });
      await transaction.gitOperationEvent.createMany({
        data: batch.items.map((item) => {
          const isSelected = selectedIds.includes(item.id);
          return {
            id: newId(),
            batchItemId: item.id,
            sequence: 4,
            fromStatus: item.status,
            toStatus: isSelected ? 'queued' : 'skipped_by_user',
          };
        }),
      });
      await transaction.job.create({
        data: {
          id: jobId,
          type: 'git.batch.execute',
          payloadRef: batch.id,
          payloadSummary: JSON.stringify({
            batchId: batch.id,
            action: batch.action,
            selectedCount: selectedIds.length,
          }),
          priority: 5,
          scheduledAt: new Date(),
          maxAttempts: 1,
          dedupeKey: `git.batch.execute:${batch.id}:${batch.version + 1}`,
        },
      });
    });
    return {
      batchId: batch.id,
      operationId: jobId,
      status: 'approved',
      batchUrl: `/api/v1/git/batches/${batch.id}`,
      statusUrl: `/api/v1/operations/${jobId}`,
    };
  }

  public async cancel(batchId: string, reason: string) {
    const batch = await this.prisma.gitBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new DomainError(errorCodes.notFound, 'Git 批次不存在', { httpStatus: 404 });
    if (
      batch.executionStartedAt ||
      ['running', 'completed', 'partial_failed', 'failed', 'needs_review'].includes(batch.status)
    ) {
      throw new DomainError('GIT_BATCH_STATE_CONFLICT', '执行已开始，不能盲目取消 Git 写进程', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
    if (['cancelled', 'expired'].includes(batch.status)) return this.get(batchId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.gitBatch.update({
        where: { id: batchId },
        data: {
          status: 'cancelled',
          cancelReason: reason,
          executionEndedAt: now,
          version: { increment: 1 },
        },
      }),
      this.prisma.job.updateMany({
        where: { payloadRef: batchId, status: 'queued' },
        data: { status: 'cancelled', cancelRequested: true, completedAt: now },
      }),
      this.prisma.job.updateMany({
        where: { payloadRef: batchId, status: 'running', type: 'git.batch.preview' },
        data: { cancelRequested: true },
      }),
    ]);
    return this.get(batchId);
  }

  public parseParameters(batch: Pick<GitBatch, 'parametersJson'>): Record<string, unknown> {
    return this.parseJson<Record<string, unknown>>(batch.parametersJson, {});
  }

  private async load(batchId: string): Promise<BatchWithItems> {
    const batch = await this.prisma.gitBatch.findUnique({
      where: { id: batchId },
      include: { items: { include: { repository: true }, orderBy: { ordinal: 'asc' } } },
    });
    if (!batch) throw new DomainError(errorCodes.notFound, 'Git 批次不存在', { httpStatus: 404 });
    return batch;
  }

  private toView(batch: BatchWithItems) {
    return {
      id: batch.id,
      action: batch.action,
      parameters: this.parseParameters(batch),
      status: batch.status,
      version: batch.version,
      previewHash: batch.previewHash,
      previewedAt: batch.previewedAt?.toISOString() ?? null,
      expiresAt: batch.expiresAt?.toISOString() ?? null,
      approvedAt: batch.approvedAt?.toISOString() ?? null,
      executionStartedAt: batch.executionStartedAt?.toISOString() ?? null,
      executionEndedAt: batch.executionEndedAt?.toISOString() ?? null,
      summary: this.parseJson(batch.summaryJson, {}),
      cancelReason: batch.cancelReason,
      createdAt: batch.createdAt.toISOString(),
      items: batch.items.map((item) => ({
        id: item.id,
        repositoryId: item.repositoryId,
        repositoryName: item.repository.displayName,
        repositoryAlias: item.repository.alias,
        status: item.status,
        previewSnapshot: this.parseJson(item.previewSnapshotJson, {}),
        displayCommand: item.displayCommand,
        expectedChanges: this.parseJson(item.expectedChangesJson, []),
        warnings: this.parseJson<GitBatchWarning[]>(item.warningsJson, []).map((warning) => ({
          ...warning,
          id: `${item.id}:${warning.id}`,
        })),
        blockingReasons: this.parseJson(item.blockingReasonsJson, []),
        riskLevel: item.riskLevel,
        executable: item.executable,
        selected: item.selected,
        resultCode: item.resultCode,
        resultSummary: item.resultSummary,
        postHeadSha: item.postHeadSha,
        outputSummary: item.outputSummary,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        startedAt: item.startedAt?.toISOString() ?? null,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    };
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
