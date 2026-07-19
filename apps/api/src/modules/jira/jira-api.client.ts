import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import type { SecureHttpResponse } from '../../infrastructure/http/secure-http.service.js';
import { SecureHttpService } from '../../infrastructure/http/secure-http.service.js';
import { jiraSearchPageSchema } from './jira.schemas.js';

const MAX_GET_URL_LENGTH = 8_000;

export interface JiraCredential {
  token: string;
  authScheme: 'bearer' | 'basic_pat';
  accountName?: string;
}

@Injectable()
export class JiraApiClient {
  public constructor(private readonly http: SecureHttpService) {}

  public async get(
    baseUrl: string,
    credential: JiraCredential,
    path: string,
    query: Record<string, string | number | undefined> = {},
    acceptedStatuses: readonly number[] = [200],
  ): Promise<SecureHttpResponse> {
    const url = this.buildUrl(baseUrl, path, query);
    const response = await this.requestWithRetry(baseUrl, credential, 'GET', url);
    if (!acceptedStatuses.includes(response.status)) throw this.statusError(response.status);
    return response;
  }

  public async searchPage(input: {
    baseUrl: string;
    credential: JiraCredential;
    jql: string;
    fields: string[];
    startAt: number;
    maxResults: number;
    method: 'post' | 'get';
  }) {
    if (input.method === 'post') {
      const url = this.buildUrl(input.baseUrl, '/search');
      const response = await this.requestWithRetry(input.baseUrl, input.credential, 'POST', url, {
        jql: input.jql,
        fields: input.fields,
        startAt: input.startAt,
        maxResults: input.maxResults,
      });
      if (response.status !== 200) throw this.statusError(response.status);
      return jiraSearchPageSchema.parse(response.body);
    }
    const url = this.buildUrl(input.baseUrl, '/search', {
      jql: input.jql,
      fields: input.fields.join(','),
      startAt: input.startAt,
      maxResults: input.maxResults,
    });
    if (url.toString().length > MAX_GET_URL_LENGTH) {
      throw new DomainError('JIRA_GET_QUERY_TOO_LONG', 'Jira 不支持 POST 搜索且 JQL 超过安全长度', {
        httpStatus: 422,
      });
    }
    const response = await this.requestWithRetry(input.baseUrl, input.credential, 'GET', url);
    if (response.status !== 200) throw this.statusError(response.status);
    return jiraSearchPageSchema.parse(response.body);
  }

  private async requestWithRetry(
    baseUrl: string,
    credential: JiraCredential,
    method: 'GET' | 'POST',
    url: URL,
    body?: unknown,
  ): Promise<SecureHttpResponse> {
    const headers = { Authorization: this.authorization(credential) };
    const base = new URL(baseUrl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response =
        method === 'POST'
          ? await this.http.postJson({
              url,
              expectedHost: base.hostname,
              allowPrivateNetwork: true,
              headers,
              timeoutMs: 20_000,
              body,
            })
          : await this.http.getJson({
              url,
              expectedHost: base.hostname,
              allowPrivateNetwork: true,
              headers,
              timeoutMs: 20_000,
            });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 2) return response;
      await this.delay(this.retryDelay(response.headers['retry-after'], attempt));
    }
    throw new DomainError('JIRA_RETRY_EXHAUSTED', 'Jira 请求重试次数耗尽', {
      httpStatus: 503,
    });
  }

  private buildUrl(
    baseUrl: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): URL {
    if (!path.startsWith('/') || /[\0\r\n]/u.test(path)) {
      throw new DomainError('JIRA_PATH_INVALID', 'Jira API 路径无效', { httpStatus: 422 });
    }
    const base = new URL(baseUrl);
    const prefix = base.pathname.replace(/\/+$/u, '');
    const url = new URL(`${base.origin}${prefix}/rest/api/2${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private authorization(credential: JiraCredential): string {
    if (credential.authScheme === 'bearer') return `Bearer ${credential.token}`;
    if (!credential.accountName) {
      throw new DomainError('JIRA_ACCOUNT_NAME_REQUIRED', 'Basic PAT 认证必须配置账号名', {
        httpStatus: 422,
      });
    }
    return `Basic ${Buffer.from(`${credential.accountName}:${credential.token}`, 'utf8').toString('base64')}`;
  }

  private statusError(status: number): DomainError {
    if (status === 400)
      return new DomainError('JIRA_QUERY_INVALID', 'Jira 拒绝 JQL 或字段参数', {
        httpStatus: 422,
      });
    if (status === 401)
      return new DomainError('JIRA_CREDENTIAL_INVALID', 'Jira 凭证无效', { httpStatus: 401 });
    if (status === 403)
      return new DomainError('JIRA_PERMISSION_DENIED', 'Jira 凭证权限不足', { httpStatus: 403 });
    if (status === 404)
      return new DomainError('JIRA_RESOURCE_NOT_VISIBLE', 'Jira 端点不存在或不可见', {
        httpStatus: 404,
      });
    if (status === 405 || status === 415)
      return new DomainError('JIRA_POST_SEARCH_UNSUPPORTED', 'Jira 实例不支持 POST 搜索', {
        httpStatus: 502,
      });
    if (status === 429)
      return new DomainError('JIRA_RATE_LIMITED', 'Jira 请求受到频率限制', {
        httpStatus: 503,
        retryable: true,
      });
    return new DomainError('JIRA_RESPONSE_ERROR', `Jira 返回 HTTP ${status}`, {
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

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  }
}
