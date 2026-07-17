import { describe, expect, it } from 'vitest';
import { SecureHttpService } from '../src/infrastructure/http/secure-http.service.js';

describe('外部 HTTPS SSRF 防护', () => {
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
