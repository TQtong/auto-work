import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import {
  SecureHttpService,
  type SecureHttpResponse,
} from '../../infrastructure/http/secure-http.service.js';

const MAX_PAGES = 500;

@Injectable()
export class GitLabApiClient {
  public constructor(private readonly http: SecureHttpService) {}

  public async get(
    baseUrl: string,
    token: string,
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    acceptedStatuses: readonly number[] = [200],
  ): Promise<SecureHttpResponse> {
    const url = this.buildApiUrl(baseUrl, path, query);
    const response = await this.requestWithRetry(baseUrl, token, url);
    if (!acceptedStatuses.includes(response.status)) throw this.statusError(response.status);
    return response;
  }

  public async list(
    baseUrl: string,
    token: string,
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown[]> {
    let url: URL | null = this.buildApiUrl(baseUrl, path, { ...query, per_page: 100, page: 1 });
    const result: unknown[] = [];
    const visited = new Set<string>();
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      if (visited.has(url.toString())) {
        throw new DomainError('GITLAB_PAGINATION_LOOP', 'GitLab 分页链接形成循环', {
          httpStatus: 502,
        });
      }
      visited.add(url.toString());
      const response = await this.requestWithRetry(baseUrl, token, url);
      if (response.status !== 200) throw this.statusError(response.status);
      if (!Array.isArray(response.body)) {
        throw new DomainError('GITLAB_LIST_INVALID', 'GitLab 列表端点返回了非数组数据', {
          httpStatus: 502,
        });
      }
      result.push(...(response.body as unknown[]));
      url = this.nextPageUrl(baseUrl, url, response.headers);
    }
    if (url) {
      throw new DomainError('GITLAB_PAGINATION_LIMIT', 'GitLab 分页超过安全上限', {
        httpStatus: 502,
      });
    }
    return result;
  }

  public projectPath(reference: string | number): string {
    return `/projects/${encodeURIComponent(this.normalizeProjectReference(reference))}`;
  }

  /**
   * 路径直查是主路径；自建 GitLab 对重命名、大小写或代理行为不一致时，仅接受搜索结果中的精确完整路径。
   */
  public async resolveProject(baseUrl: string, token: string, reference: string | number) {
    const normalized = this.normalizeProjectReference(reference);
    try {
      return (await this.get(baseUrl, token, this.projectPath(normalized))).body;
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'GITLAB_RESOURCE_NOT_VISIBLE' ||
        typeof reference === 'number' ||
        !normalized.includes('/')
      ) {
        throw error;
      }
      const search = normalized.split('/').at(-1)!;
      const candidates = await this.list(baseUrl, token, '/projects', { search, simple: true });
      const exact = candidates.find(
        (candidate) =>
          candidate !== null &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).path_with_namespace === normalized,
      );
      if (exact) return exact;
      throw error;
    }
  }

  private async requestWithRetry(baseUrl: string, token: string, url: URL) {
    const base = new URL(baseUrl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.http.getJson({
        url,
        expectedHost: base.hostname,
        allowPrivateNetwork: true,
        headers: { 'PRIVATE-TOKEN': token },
        timeoutMs: 20_000,
      });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 2) return response;
      await this.delay(this.retryDelay(response.headers['retry-after'], attempt));
    }
    throw new DomainError('GITLAB_RETRY_EXHAUSTED', 'GitLab 请求重试次数耗尽', {
      httpStatus: 503,
    });
  }

  private buildApiUrl(
    baseUrl: string,
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): URL {
    if (!path.startsWith('/') || /[\0\r\n]/u.test(path)) {
      throw new DomainError('GITLAB_PATH_INVALID', 'GitLab API 路径无效', { httpStatus: 422 });
    }
    const base = new URL(baseUrl);
    const prefix = base.pathname.replace(/\/+$/u, '');
    const url = new URL(`${base.origin}${prefix}/api/v4${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private nextPageUrl(
    baseUrl: string,
    currentUrl: URL,
    headers: Record<string, string>,
  ): URL | null {
    const link = headers.link;
    const nextLink = link
      ?.split(',')
      .map((part) => /<([^>]+)>;\s*rel="next"/u.exec(part.trim())?.[1])
      .find(Boolean);
    if (nextLink) {
      const next = new URL(nextLink);
      this.assertPaginationUrl(baseUrl, next);
      return next;
    }
    const nextPage = headers['x-next-page'];
    if (nextPage && /^\d+$/u.test(nextPage) && Number(nextPage) > 0) {
      const next = new URL(currentUrl);
      next.searchParams.set('page', nextPage);
      this.assertPaginationUrl(baseUrl, next);
      return next;
    }
    // GitLab 文档明确要求依赖分页头；不能根据“恰好返回 per_page 条”自行猜下一页。
    return null;
  }

  private assertPaginationUrl(baseUrl: string, url: URL): void {
    const base = new URL(baseUrl);
    const prefix = `${base.pathname.replace(/\/+$/u, '')}/api/v4/`;
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== base.hostname.toLowerCase() ||
      url.port !== base.port ||
      !url.pathname.startsWith(prefix) ||
      url.username ||
      url.password
    ) {
      throw new DomainError('GITLAB_PAGINATION_URL_REJECTED', 'GitLab 下一页链接越过已批准连接', {
        httpStatus: 502,
      });
    }
  }

  private statusError(status: number): DomainError {
    if (status === 401)
      return new DomainError('GITLAB_CREDENTIAL_INVALID', 'GitLab 凭证无效', { httpStatus: 401 });
    if (status === 403)
      return new DomainError('GITLAB_PERMISSION_DENIED', 'GitLab 凭证权限不足', {
        httpStatus: 403,
      });
    if (status === 404)
      return new DomainError('GITLAB_RESOURCE_NOT_VISIBLE', 'GitLab 资源不存在或当前凭证不可见', {
        httpStatus: 404,
      });
    if (status === 429)
      return new DomainError('GITLAB_RATE_LIMITED', 'GitLab 请求受到频率限制', {
        httpStatus: 503,
        retryable: true,
      });
    return new DomainError('GITLAB_RESPONSE_ERROR', `GitLab 返回 HTTP ${status}`, {
      httpStatus: status >= 500 ? 503 : 502,
      retryable: status >= 500,
    });
  }

  private retryDelay(retryAfter: string | undefined, attempt: number): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 250), 30_000);
      const dateDelay = Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(dateDelay)) return Math.min(Math.max(dateDelay, 250), 30_000);
    }
    return 500 * 2 ** attempt;
  }

  private normalizeProjectReference(reference: string | number): string {
    if (typeof reference === 'number') return String(reference);
    const normalized = reference
      .trim()
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/iu, '');
    if (!normalized || /[\0\r\n]/u.test(normalized)) {
      throw new DomainError('GITLAB_PROJECT_REFERENCE_INVALID', 'GitLab 项目标识无效', {
        httpStatus: 422,
      });
    }
    return normalized;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  }
}
