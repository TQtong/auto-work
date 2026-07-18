import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { InstanceLeaseService } from './instance-lease.service.js';
import { JobRegistryService, type JobHandler } from './job-registry.service.js';

const JOB_LEASE_MILLISECONDS = 20_000;
const MAX_GLOBAL_CONCURRENCY = 4;

@Injectable()
export class JobRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly executionOwner = newId();
  private readonly running = new Map<string, Promise<void>>();
  private readonly runningByType = new Map<string, number>();
  private polling = false;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistryService,
    private readonly instanceLease: InstanceLeaseService,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    // 进程异常退出后的写作业不能盲重放；没有明确安全恢复策略时进入 unknown。
    const expired = await this.prisma.job.findMany({
      where: { status: 'running', leaseUntil: { lt: new Date() } },
    });
    for (const job of expired) {
      const recovery = this.registry.recoveryFor(job.type);
      await this.prisma.job.update({
        where: { id: job.id },
        data:
          recovery === 'safe_replay'
            ? {
                status: 'queued',
                leaseOwner: null,
                leaseUntil: null,
                lastErrorCode: 'LEASE_RECOVERED',
              }
            : {
                status: 'unknown',
                leaseOwner: null,
                leaseUntil: null,
                completedAt: new Date(),
                lastErrorCode: 'RESULT_REQUIRES_REVIEW',
              },
      });
      if (recovery === 'manual_review') await this.markManualReviewTarget(job, 'lease_expired');
    }
  }

  @Interval(500)
  public async poll(): Promise<void> {
    if (this.polling || !this.instanceLease.isHeld || this.running.size >= MAX_GLOBAL_CONCURRENCY)
      return;
    this.polling = true;
    try {
      const candidates = await this.prisma.job.findMany({
        where: { status: 'queued', scheduledAt: { lte: new Date() }, cancelRequested: false },
        orderBy: [{ priority: 'asc' }, { scheduledAt: 'asc' }, { createdAt: 'asc' }],
        take: MAX_GLOBAL_CONCURRENCY * 3,
      });
      for (const candidate of candidates) {
        if (this.running.size >= MAX_GLOBAL_CONCURRENCY) break;
        const handler = this.registry.get(candidate.type);
        const typeCount = this.runningByType.get(candidate.type) ?? 0;
        if (!handler || typeCount >= handler.concurrency) continue;
        const claimed = await this.prisma.job.updateMany({
          where: { id: candidate.id, status: 'queued', cancelRequested: false },
          data: {
            status: 'running',
            startedAt: candidate.startedAt ?? new Date(),
            leaseOwner: this.executionOwner,
            leaseUntil: new Date(Date.now() + JOB_LEASE_MILLISECONDS),
            attemptCount: { increment: 1 },
          },
        });
        if (claimed.count !== 1) continue;
        this.runningByType.set(candidate.type, typeCount + 1);
        const execution = this.execute(candidate.id, handler).finally(() => {
          this.running.delete(candidate.id);
          this.runningByType.set(
            candidate.type,
            Math.max(0, (this.runningByType.get(candidate.type) ?? 1) - 1),
          );
        });
        this.running.set(candidate.id, execution);
      }
    } finally {
      this.polling = false;
    }
  }

  private async execute(jobId: string, handler: JobHandler): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.prisma.job.updateMany({
        where: { id: jobId, status: 'running', leaseOwner: this.executionOwner },
        data: { leaseUntil: new Date(Date.now() + JOB_LEASE_MILLISECONDS) },
      });
    }, 5_000);
    heartbeat.unref();
    try {
      const job = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const result = await handler.execute({
        jobId,
        payloadRef: job.payloadRef,
        isCancellationRequested: async () =>
          (
            await this.prisma.job.findUnique({
              where: { id: jobId },
              select: { cancelRequested: true },
            })
          )?.cancelRequested ?? true,
        reportProgress: async (progress) => {
          const normalized = Math.max(0, Math.min(99, Math.trunc(progress)));
          await this.prisma.job.updateMany({
            where: { id: jobId, status: 'running' },
            data: { progress: normalized },
          });
        },
      });
      const latest = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: latest.cancelRequested ? 'cancelled' : 'succeeded',
          progress: 100,
          resultJson: JSON.stringify(result ?? null),
          completedAt: new Date(),
          leaseOwner: null,
          leaseUntil: null,
        },
      });
    } catch (error) {
      const job = await this.prisma.job.findUnique({ where: { id: jobId } });
      if (!job) return;
      const exhausted = job.attemptCount >= job.maxAttempts;
      const retryable = !(error instanceof DomainError) || error.options.retryable === true;
      const safeReplay = handler.recovery === 'safe_replay' && retryable && !exhausted;
      const terminalNonRetryable = handler.recovery === 'safe_replay' && !retryable;
      const requiresManualReview = handler.recovery === 'manual_review';
      await this.prisma.job.update({
        where: { id: jobId },
        data: safeReplay
          ? {
              status: 'queued',
              scheduledAt: new Date(Date.now() + Math.min(60_000, 2 ** job.attemptCount * 1_000)),
              leaseOwner: null,
              leaseUntil: null,
              lastErrorCode: 'JOB_ATTEMPT_FAILED',
              lastError: this.safeError(error),
            }
          : {
              status: requiresManualReview
                ? 'unknown'
                : terminalNonRetryable
                  ? 'failed'
                  : exhausted
                    ? 'dead_letter'
                    : 'unknown',
              completedAt: new Date(),
              leaseOwner: null,
              leaseUntil: null,
              lastErrorCode: requiresManualReview
                ? 'RESULT_REQUIRES_REVIEW'
                : terminalNonRetryable
                  ? error.code
                  : exhausted
                    ? 'MAX_ATTEMPTS_EXCEEDED'
                    : 'RESULT_REQUIRES_REVIEW',
              lastError: this.safeError(error),
            },
      });
      if (handler.recovery === 'manual_review' && job.payloadRef) {
        await this.markManualReviewTarget(job, 'execution_failed');
      }
      this.logger.warn(`作业 ${jobId} 执行失败：${this.safeError(error)}`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '未知错误';
    return message
      .replace(/(?:Bearer|PRIVATE-TOKEN|token|secret|webhook)\s*[:=]?\s*\S+/gi, '[REDACTED]')
      .slice(0, 1_000);
  }

  private async markManualReviewTarget(
    job: { type: string; payloadRef: string | null },
    reason: 'lease_expired' | 'execution_failed',
  ): Promise<void> {
    if (!job.payloadRef) return;
    if (job.type === 'git.batch.execute') {
      await this.prisma.gitBatch.updateMany({
        where: { id: job.payloadRef, status: 'running' },
        data: {
          status: 'needs_review',
          executionEndedAt: new Date(),
          cancelReason:
            reason === 'lease_expired'
              ? 'Worker 租约过期，无法确认最后一个 Git 写动作是否完成'
              : 'Git 执行作业异常退出，最终仓库状态必须人工复核',
          version: { increment: 1 },
        },
      });
      return;
    }
    if (job.type === 'weekly-report.notification') {
      const notificationId = job.payloadRef;
      await this.prisma.$transaction(async (tx) => {
        const completedAt = new Date();
        await tx.robotNotification.updateMany({
          where: { id: notificationId, status: 'sending' },
          data: {
            status: 'unknown',
            lastErrorCode: 'RESULT_REQUIRES_REVIEW',
            lastErrorSummary: '通知作业中断，无法确认机器人是否已经接收消息',
            version: { increment: 1 },
          },
        });
        await tx.weeklyReportReminderOccurrence.updateMany({
          where: { notificationId, status: 'queued' },
          data: {
            status: 'unknown',
            completedAt,
            lastErrorCode: 'RESULT_REQUIRES_REVIEW',
            version: { increment: 1 },
          },
        });
      });
      return;
    }
    if (job.type === 'weekly-report.delivery') {
      const intent = await this.prisma.deliveryIntent.findUnique({
        where: { id: job.payloadRef },
        select: { id: true, reportId: true, channel: true, status: true, version: true },
      });
      if (!intent || intent.status !== 'running') return;
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.deliveryIntent.updateMany({
          where: { id: intent.id, status: 'running', version: intent.version },
          data: {
            status: 'unknown',
            recoveryStatus: 'pending',
            lastErrorCode: 'RESULT_REQUIRES_REVIEW',
            lastErrorSummary: '交付作业中断，无法确认钉钉是否已接收请求',
            completedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) return;
        await tx.weeklyReport.update({
          where: { id: intent.reportId },
          data: {
            ...(intent.channel === 'dingtalk_log'
              ? { logDeliveryState: 'unknown' }
              : { robotDeliveryState: 'unknown' }),
            version: { increment: 1 },
          },
        });
        if (intent.channel === 'dingtalk_robot') {
          await tx.robotNotification.updateMany({
            where: { deliveryIntentId: intent.id, status: 'sending' },
            data: {
              status: 'unknown',
              lastErrorCode: 'RESULT_REQUIRES_REVIEW',
              lastErrorSummary: '群摘要作业中断，无法确认机器人是否已接收消息',
              version: { increment: 1 },
            },
          });
        }
      });
    }
  }
}
