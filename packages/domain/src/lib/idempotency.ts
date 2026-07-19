import { DomainError, errorCodes } from '@auto-work/contracts';

export interface IdempotencyRecord<TResult> {
  requestHash: string;
  result?: TResult;
  state: 'processing' | 'completed' | 'failed';
}

/**
 * 幂等键只能复放完全相同的规范请求；同键异体必须显式冲突，避免把旧批准扩大到新动作。
 */
export function assertIdempotentReplay<TResult>(
  existing: IdempotencyRecord<TResult>,
  incomingRequestHash: string,
): TResult | undefined {
  if (existing.requestHash !== incomingRequestHash) {
    throw new DomainError(errorCodes.idempotencyConflict, '幂等键已用于不同请求', {
      httpStatus: 409,
      retryable: false,
      suggestedAction: 'none',
    });
  }
  return existing.result;
}
