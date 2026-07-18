import { Injectable } from '@nestjs/common';

export interface JobExecutionContext {
  jobId: string;
  payloadRef: string | null;
  isCancellationRequested: () => Promise<boolean>;
  reportProgress: (progress: number) => Promise<void>;
}

export interface JobHandler<TResult = unknown> {
  type: string;
  concurrency: number;
  recovery: 'safe_replay' | 'manual_review';
  execute(context: JobExecutionContext): Promise<TResult>;
  /** 排队中的作业尚未进入 execute，领域聚合仍可能需要撤销“运行中”状态。 */
  onQueuedCancellation?(context: { jobId: string; payloadRef: string | null }): Promise<void>;
  /** 安全重试耗尽或出现不可重试错误后，领域聚合必须离开临时运行状态。 */
  onTerminalFailure?(context: {
    jobId: string;
    payloadRef: string | null;
    errorCode: string;
  }): Promise<void>;
}

@Injectable()
export class JobRegistryService {
  private readonly handlers = new Map<string, JobHandler>();

  public register(handler: JobHandler): void {
    if (handler.concurrency < 1) throw new Error(`作业 ${handler.type} 的并发数必须大于 0`);
    if (this.handlers.has(handler.type)) throw new Error(`作业处理器重复注册：${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  public get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  public recoveryFor(type: string): JobHandler['recovery'] | undefined {
    return this.handlers.get(type)?.recovery;
  }
}
