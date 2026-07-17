import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export interface EnqueueJobInput {
  type: string;
  payloadRef?: string;
  payloadSummary?: Record<string, unknown>;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
}

@Injectable()
export class JobQueueService {
  public constructor(private readonly prisma: PrismaService) {}

  public async enqueue(input: EnqueueJobInput) {
    if (input.dedupeKey) {
      const existing = await this.prisma.job.findFirst({
        where: { dedupeKey: input.dedupeKey, status: { in: ['queued', 'running'] } },
      });
      if (existing) return existing;
    }
    try {
      return await this.prisma.job.create({
        data: {
          id: newId(),
          type: input.type,
          payloadRef: input.payloadRef ?? null,
          payloadSummary: JSON.stringify(input.payloadSummary ?? {}),
          priority: input.priority ?? 100,
          scheduledAt: input.scheduledAt ?? new Date(),
          maxAttempts: input.maxAttempts ?? 3,
          dedupeKey: input.dedupeKey ?? null,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002' ||
        !input.dedupeKey
      ) {
        throw error;
      }
      return this.prisma.job.findFirstOrThrow({
        where: { dedupeKey: input.dedupeKey, status: { in: ['queued', 'running'] } },
      });
    }
  }

  public async requestCancel(jobId: string): Promise<void> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new DomainError('JOB_NOT_FOUND', '作业不存在', { httpStatus: 404 });
    if (job.type.startsWith('git.batch.')) {
      throw new DomainError(
        'GIT_BATCH_STATE_CONFLICT',
        'Git 批次必须通过批次取消端点处理；执行开始后禁止盲目终止写进程',
        { httpStatus: 409, suggestedAction: 'manual_review' },
      );
    }
    if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(job.status)) {
      throw new DomainError('JOB_ALREADY_FINISHED', '已完成的作业不能取消', { httpStatus: 409 });
    }
    if (job.status === 'queued') {
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'cancelled', cancelRequested: true, completedAt: new Date() },
      });
      return;
    }
    await this.prisma.job.update({ where: { id: job.id }, data: { cancelRequested: true } });
  }
}
