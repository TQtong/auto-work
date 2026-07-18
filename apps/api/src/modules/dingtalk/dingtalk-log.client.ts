import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { SecureHttpService } from '../../infrastructure/http/secure-http.service.js';
import {
  dingTalkAccessTokenSchema,
  dingTalkCreateReportResponseSchema,
  dingTalkTemplateResponseSchema,
} from './dingtalk.schemas.js';

const tokenEndpoint = new URL('https://api.dingtalk.com/v1.0/oauth2/accessToken');
const tokenRefreshSkewMs = 5 * 60 * 1_000;

interface TokenCacheEntry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class DingTalkLogClient {
  private readonly tokenCache = new Map<string, TokenCacheEntry>();

  public constructor(private readonly http: SecureHttpService) {}

  public async accessToken(input: {
    appKey: string;
    appSecret: string;
    configuredAccessToken?: string | undefined;
  }): Promise<{ value: string; source: 'configured' | 'oauth2'; expiresAt: string | null }> {
    if (input.configuredAccessToken) {
      return { value: input.configuredAccessToken, source: 'configured', expiresAt: null };
    }
    const cacheKey = createHash('sha256')
      .update(`${input.appKey}\0${input.appSecret}`, 'utf8')
      .digest('hex');
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - tokenRefreshSkewMs > Date.now()) {
      return {
        value: cached.value,
        source: 'oauth2',
        expiresAt: new Date(cached.expiresAt).toISOString(),
      };
    }
    const response = await this.http.postJson({
      url: tokenEndpoint,
      expectedHost: tokenEndpoint.hostname,
      allowPrivateNetwork: false,
      timeoutMs: 20_000,
      body: { appKey: input.appKey, appSecret: input.appSecret },
    });
    if (response.status !== 200) {
      throw this.httpError(response.status, 'token');
    }
    const parsed = dingTalkAccessTokenSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new DomainError('DINGTALK_TOKEN_RESPONSE_INVALID', '钉钉令牌端点返回结构无效', {
        httpStatus: 502,
      });
    }
    const expiresAt = Date.now() + parsed.data.expireIn * 1_000;
    this.tokenCache.set(cacheKey, { value: parsed.data.accessToken, expiresAt });
    return {
      value: parsed.data.accessToken,
      source: 'oauth2',
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  public async getTemplate(input: {
    baseUrl: string;
    accessToken: string;
    templateName: string;
    operatorUserId: string;
  }) {
    const response = await this.legacyPost(
      input.baseUrl,
      input.accessToken,
      '/topapi/report/template/getbyname',
      { template_name: input.templateName, userid: input.operatorUserId },
    );
    const parsed = dingTalkTemplateResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new DomainError('DINGTALK_TEMPLATE_RESPONSE_INVALID', '钉钉日志模板端点返回结构无效', {
        httpStatus: 502,
      });
    }
    if (parsed.data.errcode !== 0) {
      throw this.apiError(parsed.data.errcode, parsed.data.request_id);
    }
    if (parsed.data.result.userid !== input.operatorUserId) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_OPERATOR_MISMATCH',
        '钉钉模板探测返回的操作用户与配置不一致',
        { httpStatus: 502 },
      );
    }
    if (parsed.data.result.name !== input.templateName) {
      throw new DomainError(
        'DINGTALK_TEMPLATE_NAME_MISMATCH',
        '钉钉模板探测返回的模板名称与配置不一致',
        { httpStatus: 502 },
      );
    }
    return {
      ...parsed.data.result,
      requestId: parsed.data.request_id ?? null,
    };
  }

  public async createReport(input: {
    baseUrl: string;
    accessToken: string;
    operatorUserId: string;
    templateId: string;
    contents: Array<{ key: string; sort: string; type: string; content: string }>;
    toUserIds: string[];
    toChat: boolean;
    source: string;
  }): Promise<{ reportId: string; requestId: string | null }> {
    if (
      input.contents.length !== 6 ||
      new Set(input.contents.map((item) => item.key)).size !== 6 ||
      new Set(input.contents.map((item) => item.sort)).size !== 6
    ) {
      throw new DomainError(
        'DINGTALK_REPORT_CONTENTS_INVALID',
        '钉钉正式日志必须包含六个名称和顺序均唯一的模板字段',
        { httpStatus: 422 },
      );
    }
    const response = await this.legacyPost(
      input.baseUrl,
      input.accessToken,
      '/topapi/report/create',
      {
        userid: input.operatorUserId,
        template_id: input.templateId,
        contents: input.contents,
        to_chat: input.toChat,
        to_userids: [...new Set(input.toUserIds)],
        dd_from: input.source,
      },
    );
    const parsed = dingTalkCreateReportResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new DomainError(
        'DINGTALK_REPORT_CREATE_RESPONSE_INVALID',
        '钉钉创建日志端点返回结构无效',
        { httpStatus: 502 },
      );
    }
    if (parsed.data.errcode !== 0) {
      throw this.apiError(parsed.data.errcode, parsed.data.request_id);
    }
    return {
      reportId:
        typeof parsed.data.result === 'string' ? parsed.data.result : parsed.data.result.report_id,
      requestId: parsed.data.request_id ?? null,
    };
  }

  private async legacyPost(baseUrl: string, accessToken: string, path: string, body: unknown) {
    const base = this.assertLegacyBaseUrl(baseUrl);
    const url = new URL(path, `${base.origin}/`);
    url.searchParams.set('access_token', accessToken);
    const response = await this.http.postJson({
      url,
      expectedHost: base.hostname,
      allowPrivateNetwork: false,
      timeoutMs: 20_000,
      body,
    });
    if (response.status !== 200) throw this.httpError(response.status, 'report');
    return response;
  }

  private assertLegacyBaseUrl(value: string): URL {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'oapi.dingtalk.com' ||
      Boolean(url.port) ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new DomainError(
        'DINGTALK_LOG_BASE_URL_REJECTED',
        '钉钉正式日志只允许固定基础地址 https://oapi.dingtalk.com',
        { httpStatus: 422 },
      );
    }
    return url;
  }

  private httpError(status: number, stage: 'token' | 'report'): DomainError {
    if (status === 400 || status === 401) {
      return new DomainError('DINGTALK_CREDENTIAL_INVALID', '钉钉应用凭证无效', {
        httpStatus: 401,
      });
    }
    if (status === 403) {
      return new DomainError('DINGTALK_PERMISSION_DENIED', '钉钉应用缺少日志接口权限', {
        httpStatus: 403,
      });
    }
    if (status === 429) {
      return new DomainError('DINGTALK_RATE_LIMITED', '钉钉接口受到频率限制', {
        httpStatus: 503,
        retryable: true,
        details: { stage },
      });
    }
    return new DomainError('DINGTALK_RESPONSE_ERROR', `钉钉接口返回 HTTP ${status}`, {
      httpStatus: status >= 500 ? 503 : 502,
      retryable: status >= 500,
      details: { stage },
    });
  }

  private apiError(errcode: number, requestId?: string): DomainError {
    if ([40001, 40014, 40078, 42001].includes(errcode)) {
      return new DomainError('DINGTALK_CREDENTIAL_INVALID', '钉钉访问令牌无效或已过期', {
        httpStatus: 401,
        details: { errcode, requestId: requestId ?? null },
      });
    }
    if ([60011, 60020, 88].includes(errcode)) {
      return new DomainError('DINGTALK_PERMISSION_DENIED', '钉钉应用缺少日志或通讯录权限', {
        httpStatus: 403,
        details: { errcode, requestId: requestId ?? null },
      });
    }
    if ([400003, 60121].includes(errcode)) {
      return new DomainError('DINGTALK_OPERATOR_INVALID', '钉钉操作用户不存在或不可见', {
        httpStatus: 422,
        details: { errcode, requestId: requestId ?? null },
      });
    }
    return new DomainError('DINGTALK_API_ERROR', `钉钉日志接口返回错误码 ${errcode}`, {
      httpStatus: 502,
      details: { errcode, requestId: requestId ?? null },
    });
  }
}
