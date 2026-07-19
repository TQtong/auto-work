import { isIP } from 'node:net';
import { DomainError } from '@auto-work/contracts';

export interface UrlPolicy {
  allowPrivateNetwork: boolean;
  allowedHosts?: readonly string[];
}

/** 先做不依赖 DNS 的 URL 语义校验；发请求前还必须对解析后的每个 IP 再做校验。 */
export function normalizeHttpsBaseUrl(value: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError('INTEGRATION_URL_INVALID', '集成地址不是有效 URL', { httpStatus: 422 });
  }
  if (url.protocol !== 'https:') {
    throw new DomainError('INTEGRATION_HTTPS_REQUIRED', '集成地址必须使用 HTTPS', {
      httpStatus: 422,
    });
  }
  if (url.username || url.password || url.hash) {
    throw new DomainError(
      'INTEGRATION_URL_CREDENTIAL_REJECTED',
      '地址中不能包含用户名、密码或片段',
      {
        httpStatus: 422,
      },
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (['localhost', 'localhost.localdomain'].includes(hostname)) {
    throw new DomainError('INTEGRATION_LOOPBACK_REJECTED', '集成地址不能指向本机', {
      httpStatus: 422,
    });
  }
  if (
    policy.allowedHosts &&
    !policy.allowedHosts.map((host) => host.toLowerCase()).includes(hostname)
  ) {
    throw new DomainError('INTEGRATION_HOST_NOT_ALLOWED', '集成地址不在允许主机列表中', {
      httpStatus: 422,
    });
  }
  if (isIP(hostname) && !isAddressAllowed(hostname, policy.allowPrivateNetwork)) {
    throw new DomainError('INTEGRATION_ADDRESS_REJECTED', '集成地址指向受保护网络', {
      httpStatus: 422,
    });
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function isAddressAllowed(address: string, allowPrivateNetwork: boolean): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const [a = -1, b = -1] = octets;
    if (a === 0 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    // 云元数据常用地址必须始终阻断，即使企业连接允许私网。
    if (normalized === '169.254.169.254') return false;
    const privateV4 =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    return allowPrivateNetwork || !privateV4;
  }
  if (isIP(normalized) === 6) {
    const mappedIpv4 = mappedIpv4Address(normalized);
    if (mappedIpv4) return isAddressAllowed(mappedIpv4, allowPrivateNetwork);
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('ff') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
      return false;
    const privateV6 = normalized.startsWith('fc') || normalized.startsWith('fd');
    return allowPrivateNetwork || !privateV6;
  }
  return false;
}

/** IPv4-mapped IPv6 必须回落到 IPv4 规则，避免以另一种字面量绕过 loopback/metadata。 */
function mappedIpv4Address(address: string): string | null {
  const match = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/iu.exec(address);
  if (!match?.[1]) return null;
  if (isIP(match[1]) === 4) return match[1];
  const words = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(match[1]);
  if (!words?.[1] || !words[2]) return null;
  const high = Number.parseInt(words[1], 16);
  const low = Number.parseInt(words[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}
