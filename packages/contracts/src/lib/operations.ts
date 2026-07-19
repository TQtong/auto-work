import { z } from 'zod';

export const operationStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'dead_letter',
]);

export type OperationStatus = z.infer<typeof operationStatusSchema>;

export interface OperationResource<TResult = unknown> {
  id: string;
  type: string;
  status: OperationStatus;
  progress: number;
  cancellable: boolean;
  result?: TResult;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
