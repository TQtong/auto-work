import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { DomainError } from '@auto-work/contracts';
import { isAddressAllowed } from '@auto-work/domain';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function createPinnedLookup(selected: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    // Node 20+ may request all addresses while auto-selecting an IP family. In that mode the
    // lookup callback must return an array; returning the legacy address/family pair makes
    // node:net read `address.address` from a string and fail with ERR_INVALID_IP_ADDRESS.
    if (options.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

export interface SecureHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

@Injectable()
export class SecureHttpService {
  public async getJson(input: {
    url: URL;
    expectedHost: string;
    headers?: Record<string, string>;
    allowPrivateNetwork: boolean;
    timeoutMs?: number;
  }): Promise<SecureHttpResponse> {
    return this.requestJson({ ...input, method: 'GET' });
  }

  public async postJson(input: {
    url: URL;
    expectedHost: string;
    headers?: Record<string, string>;
    allowPrivateNetwork: boolean;
    timeoutMs?: number;
    body: unknown;
  }): Promise<SecureHttpResponse> {
    const encodedBody = Buffer.from(JSON.stringify(input.body), 'utf8');
    if (encodedBody.length > 512 * 1024) {
      throw new DomainError('EXTERNAL_REQUEST_TOO_LARGE', '外部请求正文超过安全上限', {
        httpStatus: 422,
      });
    }
    return this.requestJson({ ...input, method: 'POST', encodedBody });
  }

  private async requestJson(input: {
    url: URL;
    expectedHost: string;
    headers?: Record<string, string>;
    allowPrivateNetwork: boolean;
    timeoutMs?: number;
    method: 'GET' | 'POST';
    encodedBody?: Buffer;
  }): Promise<SecureHttpResponse> {
    this.assertUrl(input.url, input.expectedHost);
    const addresses = await lookup(input.url.hostname, { all: true, verbatim: true }).catch(() => {
      throw new DomainError('EXTERNAL_DNS_FAILED', '外部服务域名解析失败', {
        httpStatus: 503,
        retryable: true,
      });
    });
    if (addresses.length === 0) {
      throw new DomainError('EXTERNAL_DNS_EMPTY', '外部服务域名没有可用地址', {
        httpStatus: 503,
      });
    }
    // 任一解析结果越过网络策略都整体拒绝，防止轮询 DNS 或重绑定选择到受保护地址。
    if (addresses.some(({ address }) => !isAddressAllowed(address, input.allowPrivateNetwork))) {
      throw new DomainError('EXTERNAL_ADDRESS_REJECTED', '外部服务解析到受保护网络地址', {
        httpStatus: 403,
      });
    }
    const selected = addresses[0]!;
    const pinnedLookup = createPinnedLookup(selected);

    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const req = request(
        input.url,
        {
          method: input.method,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Auto-Work/0.1',
            ...(input.encodedBody
              ? {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Content-Length': String(input.encodedBody.length),
                }
              : {}),
            ...input.headers,
          },
          lookup: pinnedLookup,
          servername: input.url.hostname,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_RESPONSE_BYTES) {
              response.destroy();
              if (!settled) {
                settled = true;
                reject(
                  new DomainError('EXTERNAL_RESPONSE_TOO_LARGE', '外部响应超过安全上限', {
                    httpStatus: 502,
                  }),
                );
              }
              return;
            }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            if (text) {
              try {
                body = JSON.parse(text) as unknown;
              } catch {
                reject(
                  new DomainError('EXTERNAL_JSON_INVALID', '外部服务返回了无效 JSON', {
                    httpStatus: 502,
                  }),
                );
                return;
              }
            }
            const headers = Object.fromEntries(
              Object.entries(response.headers).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : [[key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]],
              ),
            );
            resolvePromise({ status: response.statusCode ?? 0, headers, body });
          });
        },
      );
      req.setTimeout(input.timeoutMs ?? 15_000, () => {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(
            new DomainError('EXTERNAL_REQUEST_TIMEOUT', '外部服务请求超时', {
              httpStatus: 504,
              retryable: true,
            }),
          );
        }
      });
      req.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(
          new DomainError('EXTERNAL_REQUEST_FAILED', '外部服务连接失败', {
            httpStatus: 503,
            retryable: true,
            details: { causeCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' },
          }),
        );
      });
      if (input.encodedBody) req.write(input.encodedBody);
      req.end();
    });
  }

  private assertUrl(url: URL, expectedHost: string): void {
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new DomainError('EXTERNAL_URL_REJECTED', '外部请求必须是无凭证 HTTPS URL', {
        httpStatus: 422,
      });
    }
    if (url.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      throw new DomainError('EXTERNAL_REDIRECT_HOST_REJECTED', '外部请求主机与已批准连接不一致', {
        httpStatus: 403,
      });
    }
  }
}
