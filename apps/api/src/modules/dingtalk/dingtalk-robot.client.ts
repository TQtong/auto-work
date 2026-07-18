import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { SecureHttpService } from '../../infrastructure/http/secure-http.service.js';
import { dingTalkRobotResponseSchema } from './dingtalk.schemas.js';

export const dingTalkRobotMaximumTextBytes = 18_000;

export function validateDingTalkRobotWebhook(webhook: string): URL {
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    throw new DomainError('DINGTALK_ROBOT_WEBHOOK_INVALID', '钉钉机器人 Webhook 不是有效 URL', {
      httpStatus: 422,
    });
  }
  const queryKeys = [...url.searchParams.keys()];
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'oapi.dingtalk.com' ||
    Boolean(url.port) ||
    url.pathname !== '/robot/send' ||
    !url.searchParams.get('access_token') ||
    queryKeys.length !== 1 ||
    queryKeys.some((key) => key !== 'access_token') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new DomainError(
      'DINGTALK_ROBOT_WEBHOOK_REJECTED',
      'Webhook 必须是钉钉官方 oapi.dingtalk.com/robot/send 加签机器人地址',
      { httpStatus: 422 },
    );
  }
  return url;
}

@Injectable()
export class DingTalkRobotClient {
  public constructor(private readonly http: SecureHttpService) {}

  public async sendText(input: {
    webhook: string;
    secret: string;
    text: string;
    timestamp?: number | undefined;
  }): Promise<{ requestId: string | null; timestamp: number }> {
    if (Buffer.byteLength(input.text, 'utf8') > dingTalkRobotMaximumTextBytes) {
      throw new DomainError('DINGTALK_ROBOT_MESSAGE_TOO_LARGE', '钉钉机器人文本超过安全上限', {
        httpStatus: 422,
      });
    }
    const url = this.signedUrl(input.webhook, input.secret, input.timestamp ?? Date.now());
    const response = await this.http.postJson({
      url,
      expectedHost: url.hostname,
      allowPrivateNetwork: false,
      timeoutMs: 15_000,
      body: { msgtype: 'text', text: { content: input.text }, at: { isAtAll: false } },
    });
    if (response.status !== 200) throw this.httpError(response.status);
    const parsed = dingTalkRobotResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new DomainError('DINGTALK_ROBOT_RESPONSE_INVALID', '钉钉机器人返回结构无效', {
        httpStatus: 502,
      });
    }
    if (parsed.data.errcode !== 0) {
      throw this.apiError(parsed.data.errcode, parsed.data.request_id);
    }
    return {
      requestId: parsed.data.request_id ?? null,
      timestamp: Number(url.searchParams.get('timestamp')),
    };
  }

  public validateWebhook(webhook: string): URL {
    return validateDingTalkRobotWebhook(webhook);
  }

  private signedUrl(webhook: string, secret: string, timestamp: number): URL {
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new DomainError('DINGTALK_ROBOT_TIMESTAMP_INVALID', '钉钉机器人时间戳无效', {
        httpStatus: 422,
      });
    }
    const url = this.validateWebhook(webhook);
    const sign = createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`, 'utf8')
      .digest('base64');
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    return url;
  }

  private httpError(status: number): DomainError {
    if (status === 401 || status === 403) {
      return new DomainError('DINGTALK_ROBOT_PERMISSION_DENIED', '钉钉机器人凭证或加签无效', {
        httpStatus: 403,
      });
    }
    if (status === 429) {
      return new DomainError('DINGTALK_ROBOT_RATE_LIMITED', '钉钉机器人受到频率限制', {
        httpStatus: 503,
        retryable: true,
      });
    }
    return new DomainError('DINGTALK_ROBOT_RESPONSE_ERROR', `钉钉机器人返回 HTTP ${status}`, {
      httpStatus: status >= 500 ? 503 : 502,
      retryable: status >= 500,
    });
  }

  private apiError(errcode: number, requestId?: string): DomainError {
    if ([310000, 40035].includes(errcode)) {
      return new DomainError(
        'DINGTALK_ROBOT_SIGNATURE_INVALID',
        '钉钉机器人加签、关键词或安全设置校验失败',
        { httpStatus: 422, details: { errcode, requestId: requestId ?? null } },
      );
    }
    if ([130101, 130102].includes(errcode)) {
      return new DomainError('DINGTALK_ROBOT_RATE_LIMITED', '钉钉机器人受到频率限制', {
        httpStatus: 503,
        retryable: true,
        details: { errcode, requestId: requestId ?? null },
      });
    }
    return new DomainError('DINGTALK_ROBOT_API_ERROR', `钉钉机器人返回错误码 ${errcode}`, {
      httpStatus: 502,
      details: { errcode, requestId: requestId ?? null },
    });
  }
}
