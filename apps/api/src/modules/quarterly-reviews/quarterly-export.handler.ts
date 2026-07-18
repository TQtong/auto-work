import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { QuarterlyExportService } from './quarterly-export.service.js';

@Injectable()
export class QuarterlyExportHandler implements JobHandler, OnModuleInit {
  public readonly type = 'quarterly-review.export';
  // 文档生成限制为单并发，避免大工作簿和 Word 打包同时争用本机内存。
  public readonly concurrency = 1;
  public readonly recovery = 'safe_replay' as const;

  public constructor(
    private readonly jobs: JobRegistryService,
    private readonly exports: QuarterlyExportService,
  ) {}

  public onModuleInit(): void {
    this.jobs.register(this);
  }

  public async execute(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) {
      throw new DomainError('QUARTERLY_EXPORT_ID_MISSING', '季度导出作业缺少制品 ID', {
        httpStatus: 500,
      });
    }
    return this.exports.execute(
      context.jobId,
      context.payloadRef,
      context.reportProgress,
      context.isCancellationRequested,
    );
  }

  public async onQueuedCancellation(context: {
    jobId: string;
    payloadRef: string | null;
  }): Promise<void> {
    // queued 作业不会进入 execute，必须由队列回调同步收口制品状态。
    if (!context.payloadRef) return;
    await this.exports.markQueuedCancellation(context.jobId, context.payloadRef);
  }

  public async onTerminalFailure(context: {
    jobId: string;
    payloadRef: string | null;
    errorCode: string;
  }): Promise<void> {
    // 重试耗尽后的终态由统一回调写入，确保失败审计与错误码不会丢失。
    if (!context.payloadRef) return;
    await this.exports.markUnexpectedFailure(context.jobId, context.payloadRef, context.errorCode);
  }
}
