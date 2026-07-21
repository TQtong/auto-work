import { describe, expect, it } from 'vitest';
import {
  createPinnedLookup,
  SecureHttpService,
} from '../src/infrastructure/http/secure-http.service.js';

function runLookup(all: boolean) {
  const lookup = createPinnedLookup({ address: '10.10.6.20', family: 4 });
  return new Promise<{
    address: string | { address: string; family: number }[];
    family: number | undefined;
  }>((resolve, reject) => {
    lookup('jira.example.com', { all }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address, family });
    });
  });
}

describe('外部 HTTPS SSRF 防护', () => {
  it('固定 DNS 回调兼容 Node 的单地址和 all 地址查询', async () => {
    await expect(runLookup(false)).resolves.toEqual({ address: '10.10.6.20', family: 4 });
    await expect(runLookup(true)).resolves.toEqual({
      address: [{ address: '10.10.6.20', family: 4 }],
      family: undefined,
    });
  });

  it.each([
    'https://127.0.0.1/api/v4/user',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]/api/v4/user',
    'https://[::ffff:a9fe:a9fe]/latest/meta-data',
  ])('即使允许企业私网也拒绝受保护地址 %s', async (url) => {
    const service = new SecureHttpService();
    await expect(
      service.getJson({
        url: new URL(url),
        expectedHost: new URL(url).hostname,
        allowPrivateNetwork: true,
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ADDRESS_REJECTED' });
  });

  it('在 DNS 请求前拒绝主机越界', async () => {
    const service = new SecureHttpService();
    await expect(
      service.getJson({
        url: new URL('https://attacker.example/api/v4/user'),
        expectedHost: 'git.example.com',
        allowPrivateNetwork: false,
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_REDIRECT_HOST_REJECTED' });
  });

  it('POST 正文超过 512 KiB 时在 DNS 与网络请求前拒绝', async () => {
    const service = new SecureHttpService();
    await expect(
      service.postJson({
        url: new URL('https://jira.example.com/rest/api/2/search'),
        expectedHost: 'jira.example.com',
        allowPrivateNetwork: false,
        body: { jql: 'x'.repeat(512 * 1024) },
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_REQUEST_TOO_LARGE' });
  });
});
