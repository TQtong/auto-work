import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiDownload, apiRequest, getSession } from './client.js';

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

  it('下载同源二进制文件并优先解析 UTF-8 文件名', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(['季度文件']), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition':
            'attachment; filename="quarterly.xlsx"; filename*=UTF-8\'\'%E5%AD%A3%E5%BA%A6%E8%87%AA%E8%AF%84.xlsx',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = await apiDownload('/api/v1/quarterly-reviews/review/exports/artifact/download');
    expect(file.fileName).toBe('季度自评.xlsx');
    expect(file.contentType).toContain('spreadsheetml');
    expect(file.sizeBytes).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/quarterly-reviews/review/exports/artifact/download',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    );
  });

  it('把下载失败的 JSON 错误恢复为统一客户端异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'QUARTERLY_EXPORT_FILE_CORRUPTED',
            message: '导出文件完整性校验失败，禁止下载',
            correlationId: 'download-correlation',
            retryable: false,
            suggestedAction: 'manual_review',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    await expect(apiDownload('/api/v1/download')).rejects.toMatchObject({
      status: 409,
      payload: { code: 'QUARTERLY_EXPORT_FILE_CORRUPTED' },
    });
  });
});
