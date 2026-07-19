import { describe, expect, it, vi } from 'vitest';
import type { SecureHttpService } from '../src/infrastructure/http/secure-http.service.js';
import { JiraApiClient } from '../src/modules/jira/jira-api.client.js';

describe('Jira REST 适配器', () => {
  it('POST search 使用字段白名单、显式分页和仅请求头中的 Bearer 凭证', async () => {
    const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: { startAt: 0, maxResults: 2, total: 1, issues: [] },
    });
    const client = new JiraApiClient({ postJson } as unknown as SecureHttpService);
    await client.searchPage({
      baseUrl: 'https://jira.example.com/company',
      credential: { token: 'secret-token-value', authScheme: 'bearer' },
      jql: 'assignee = currentUser() ORDER BY updated ASC, key ASC',
      fields: ['summary', 'updated'],
      startAt: 0,
      maxResults: 2,
      method: 'post',
    });

    const request = postJson.mock.calls[0]![0];
    expect(request.url.toString()).toBe('https://jira.example.com/company/rest/api/2/search');
    expect(request.body).toEqual({
      jql: 'assignee = currentUser() ORDER BY updated ASC, key ASC',
      fields: ['summary', 'updated'],
      startAt: 0,
      maxResults: 2,
    });
    expect(request.headers).toEqual({ Authorization: 'Bearer secret-token-value' });
    expect(request.url.toString()).not.toContain('secret-token-value');
  });

  it('Basic PAT 缺少账号名时在发出网络请求前拒绝', async () => {
    const getJson = vi.fn<SecureHttpService['getJson']>();
    const client = new JiraApiClient({ getJson } as unknown as SecureHttpService);
    await expect(
      client.get(
        'https://jira.example.com',
        { token: 'secret-token-value', authScheme: 'basic_pat' },
        '/myself',
      ),
    ).rejects.toMatchObject({ code: 'JIRA_ACCOUNT_NAME_REQUIRED' });
    expect(getJson).not.toHaveBeenCalled();
  });

  it('GET fallback 正确编码 JQL 与字段且拒绝超长 URL', async () => {
    const getJson = vi.fn<SecureHttpService['getJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: { issues: [] },
    });
    const client = new JiraApiClient({ getJson } as unknown as SecureHttpService);
    await client.searchPage({
      baseUrl: 'https://jira.example.com',
      credential: { token: 'secret-token-value', authScheme: 'bearer' },
      jql: 'assignee = currentUser()',
      fields: ['summary', 'customfield_10001'],
      startAt: 4,
      maxResults: 2,
      method: 'get',
    });
    expect(getJson.mock.calls[0]![0].url.searchParams.get('startAt')).toBe('4');
    expect(getJson.mock.calls[0]![0].url.searchParams.get('fields')).toBe(
      'summary,customfield_10001',
    );
    await expect(
      client.searchPage({
        baseUrl: 'https://jira.example.com',
        credential: { token: 'secret-token-value', authScheme: 'bearer' },
        jql: `summary ~ "${'x'.repeat(9_000)}"`,
        fields: ['summary'],
        startAt: 0,
        maxResults: 1,
        method: 'get',
      }),
    ).rejects.toMatchObject({ code: 'JIRA_GET_QUERY_TOO_LONG' });
  });
});
