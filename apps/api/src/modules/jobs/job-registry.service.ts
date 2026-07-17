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
