import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@auto-work/contracts';
import type {
  SecureHttpResponse,
  SecureHttpService,
} from '../src/infrastructure/http/secure-http.service.js';
import { GitLabApiClient } from '../src/modules/gitlab/gitlab-api.client.js';

function response(body: unknown, headers: Record<string, string> = {}): SecureHttpResponse {
  return { status: 200, body, headers };
}

describe('GitLab REST 客户端', () => {
  it('优先跟随 Link，再兼容 X-Next-Page，且不按数组长度猜页', async () => {
    const getJson = vi
      .fn<SecureHttpService['getJson']>()
      .mockResolvedValueOnce(
        response([{ id: 1 }], {
          link: '<https://git.example.com/api/v4/projects?page=2&per_page=100>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(response([{ id: 2 }], { 'x-next-page': '3' }))
      .mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, id) => ({ id: id + 3 }))));
    const client = new GitLabApiClient({ getJson } as unknown as SecureHttpService);

    const values = await client.list('https://git.example.com', 'test-token', '/projects');
    expect(values).toHaveLength(102);
    expect(getJson).toHaveBeenCalledTimes(3);
    expect(getJson.mock.calls[2]?.[0].url.searchParams.get('page')).toBe('3');
  });

  it('拒绝 Link 将凭证请求导向其他主机', async () => {
    const getJson = vi.fn<SecureHttpService['getJson']>().mockResolvedValue(
      response([], {
        link: '<https://attacker.example/api/v4/projects?page=2>; rel="next"',
      }),
    );
    const client = new GitLabApiClient({ getJson } as unknown as SecureHttpService);
    await expect(
      client.list('https://git.example.com', 'test-token', '/projects'),
    ).rejects.toMatchObject({
      code: 'GITLAB_PAGINATION_URL_REJECTED',
    });
  });

  it('将认证、权限、不可见和限频分类为稳定错误码', async () => {
    for (const [status, code] of [
      [401, 'GITLAB_CREDENTIAL_INVALID'],
      [403, 'GITLAB_PERMISSION_DENIED'],
      [404, 'GITLAB_RESOURCE_NOT_VISIBLE'],
    ] as const) {
      const getJson = vi
        .fn<SecureHttpService['getJson']>()
        .mockResolvedValue({ status, body: {}, headers: {} });
      const client = new GitLabApiClient({ getJson } as unknown as SecureHttpService);
      await expect(
        client.get('https://git.example.com', 'test-token', '/user'),
      ).rejects.toMatchObject({
        code,
      });
    }
  });

  it('拒绝调用方注入换行 API 路径', async () => {
    const client = new GitLabApiClient({
      getJson: vi.fn<SecureHttpService['getJson']>(),
    } as unknown as SecureHttpService);
    await expect(
      client.get('https://git.example.com', 'token', '/user\nX-Test: 1'),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('路径直查不可见时仅采用搜索中的大小写精确完整路径', async () => {
    const getJson = vi
      .fn<SecureHttpService['getJson']>()
      .mockResolvedValueOnce({ status: 404, body: {}, headers: {} })
      .mockResolvedValueOnce(
        response([
          { id: 1, path_with_namespace: 'group/project' },
          { id: 2, path_with_namespace: 'Group/Project' },
        ]),
      );
    const client = new GitLabApiClient({ getJson } as unknown as SecureHttpService);

    await expect(
      client.resolveProject('https://git.example.com', 'token-value', '/Group/Project.git'),
    ).resolves.toMatchObject({ id: 2 });
    expect(getJson.mock.calls[0]?.[0].url.pathname).toContain('Group%2FProject');
    expect(getJson.mock.calls[1]?.[0].url.searchParams.get('search')).toBe('Project');
  });

  it('429 和 5xx 才按 Retry-After/指数退避重试', async () => {
    vi.useFakeTimers();
    try {
      const getJson = vi
        .fn<SecureHttpService['getJson']>()
        .mockResolvedValueOnce({ status: 429, body: {}, headers: { 'retry-after': '0' } })
        .mockResolvedValueOnce(response({ id: 7 }));
      const client = new GitLabApiClient({ getJson } as unknown as SecureHttpService);
      const pending = client.get('https://git.example.com', 'token-value', '/user');
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(getJson).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
