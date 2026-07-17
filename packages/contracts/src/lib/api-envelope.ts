import { z } from 'zod';

export interface ApiMeta {
  asOf?: string;
  correlationId: string;
  stale?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  meta: ApiMeta;
}

export interface CursorPage {
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  limit: number;
}

export interface ApiListResponse<T> extends ApiResponse<T[]> {
  page: CursorPage;
}

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function apiResponse<T>(
  data: T,
  correlationId: string,
  meta?: Omit<ApiMeta, 'correlationId'>,
): ApiResponse<T> {
  return { data, meta: { correlationId, ...meta } };
}
