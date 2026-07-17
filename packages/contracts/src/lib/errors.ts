export const errorCodes = {
  invalidRequest: 'INVALID_REQUEST',
  unauthorized: 'LOCAL_SESSION_REQUIRED',
  csrfRejected: 'CSRF_REJECTED',
  hostRejected: 'HOST_REJECTED',
  originRejected: 'ORIGIN_REJECTED',
  notFound: 'RESOURCE_NOT_FOUND',
  versionConflict: 'VERSION_CONFLICT',
  idempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  dependencyUnavailable: 'DEPENDENCY_UNAVAILABLE',
  internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = string;
export type SuggestedAction = 'refresh' | 'reconfigure' | 'reconfirm' | 'manual_review' | 'none';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
  retryable: boolean;
  suggestedAction: SuggestedAction;
}

export class DomainError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly options: {
      details?: unknown;
      httpStatus?: number;
      retryable?: boolean;
      suggestedAction?: SuggestedAction;
    } = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
