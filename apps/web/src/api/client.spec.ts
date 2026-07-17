import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, getSession } from './client.js';

describe('浏览器 API 客户端', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('把 CSRF 令牌只放入变更请求头', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              profileId: 'profile',
              windowsSidSummary: 'S-1…1001',
              displayName: '测试用户',
              timezone: 'Asia/Shanghai',
              csrfToken: 'a'.repeat(64),
            },
            meta: { correlationId: 'correlation-session' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { saved: true }, meta: { correlationId: 'correlation-save' } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await getSession();
    await apiRequest('/api/v1/example', { method: 'POST', body: JSON.stringify({ value: 1 }) });
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(request.headers).get('X-CSRF-Token')).toBe('a'.repeat(64));
    expect(new Headers(request.headers).get('Content-Type')).toContain('application/json');
  });
});
