import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';

@Injectable()
export class QuarterlyCollectionHandler implements JobHandler, OnModuleInit {
  public readonly type = 'quarterly-review.collect';
  public readonly concurrency = 1;
  public readonly recovery = 'safe_replay' as const;

  public constructor(
    private readonly jobs: JobRegistryService,
    private readonly collection: QuarterlyCollectionService,
  ) {}

  public onModuleInit(): void {
    this.jobs.register(this);
  }

  public async execute(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) {
      throw new DomainError('QUARTERLY_REVIEW_ID_MISSING', '季度收集作业缺少评审 ID', {
        httpStatus: 500,
      });
    }
    return this.collection.execute(
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
    if (!context.payloadRef) return;
    await this.collection.restoreAfterCancellation(context.jobId, context.payloadRef);
  }

  public async onTerminalFailure(context: {
    jobId: string;
    payloadRef: string | null;
    errorCode: string;
  }): Promise<void> {
    if (!context.payloadRef) return;
    await this.collection.markUnexpectedFailure(
      context.jobId,
      context.payloadRef,
      context.errorCode,
    );
  }
}
