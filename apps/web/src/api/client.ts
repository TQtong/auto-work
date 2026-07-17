export interface ApiEnvelope<T> {
  data: T;
  meta: { correlationId: string; asOf?: string; stale?: boolean };
  page?: { cursor?: string; nextCursor?: string; hasMore: boolean; limit: number };
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  correlationId: string;
  retryable: boolean;
  suggestedAction: string;
}

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly payload: ApiErrorPayload,
  ) {
    super(payload.message);
    this.name = 'ApiClientError';
  }
}

export interface LocalSession {
  profileId: string;
  windowsSidSummary: string;
  displayName: string;
  timezone: string;
  csrfToken: string;
}

let sessionPromise: Promise<ApiEnvelope<LocalSession>> | undefined;

export async function getSession(): Promise<ApiEnvelope<LocalSession>> {
  sessionPromise ??= rawRequest<ApiEnvelope<LocalSession>>('/api/v1/session', {
    method: 'GET',
  }).catch((error) => {
    sessionPromise = undefined;
    throw error;
  });
  return sessionPromise;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    // CSRF 令牌只保存在页面内存中，绝不写 localStorage、URL 或日志。
    headers.set('X-CSRF-Token', (await getSession()).data.csrfToken);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  return rawRequest<ApiEnvelope<T>>(path, { ...init, method, headers });
}

async function rawRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
  const payload = (await response.json()) as T | ApiErrorPayload;
  if (!response.ok) throw new ApiClientError(response.status, payload as ApiErrorPayload);
  return payload as T;
}
