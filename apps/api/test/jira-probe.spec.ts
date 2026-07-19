import { DomainError } from '@auto-work/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';
import type { JiraApiClient } from '../src/modules/jira/jira-api.client.js';
import { JiraProbeService } from '../src/modules/jira/jira-probe.service.js';

const target = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'jira' as const,
  baseUrl: 'https://jira.example.com',
  config: { authScheme: 'bearer' },
  credential: { token: 'fixture-token' },
};

describe('Jira 能力探测', () => {
  it('严格按身份、字段、项目、POST 搜索顺序探测并提示配置映射', async () => {
    const calls: string[] = [];
    const get = vi.fn((_base: string, _credential: unknown, path: string) => {
      calls.push(path);
      if (path === '/myself')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { accountId: 'u1', displayName: '当前用户' },
        });
      if (path === '/field')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [{ id: 'status', name: '状态', schema: { type: 'status' } }],
        });
      if (path === '/project')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [{ id: '1', key: 'PROJ', name: '项目' }],
        });
      if (path === '/status')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [{ id: '3', name: '进行中' }],
        });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const searchPage = vi.fn(() => {
      calls.push('/search:post');
      return Promise.resolve({
        startAt: 0,
        total: 1,
        issues: [{ id: '1', key: 'PROJ-1', fields: { status: { id: '3', name: '进行中' } } }],
      });
    });
    const service = new JiraProbeService(
      { register: vi.fn() } as unknown as IntegrationProbeRegistry,
      {
        fieldMappingVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { get, searchPage } as unknown as JiraApiClient,
    );
    const result = await service.probe(target);

    expect(calls).toEqual(['/myself', '/field', '/project', '/search:post', '/status']);
    expect(result).toMatchObject({
      healthy: false,
      status: 'configuration_required',
      identity: { id: 'u1', name: '当前用户' },
      errorCode: 'JIRA_MAPPING_REQUIRED',
    });
    expect(result.capabilities).toMatchObject({
      authenticated: true,
      search: { post: true, selectedMethod: 'post' },
      sampleIssueCount: 1,
      readOnly: true,
    });
  });

  it('POST search 不受支持时只回退一次 GET，已有映射后连接健康', async () => {
    const get = vi.fn((_base: string, _credential: unknown, path: string) => {
      if (path === '/myself')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { key: 'legacy-user', displayName: '旧版用户' },
        });
      return Promise.resolve({ status: 200, headers: {}, body: [] });
    });
    const searchPage = vi
      .fn()
      .mockRejectedValueOnce(new DomainError('JIRA_POST_SEARCH_UNSUPPORTED', '不支持'))
      .mockResolvedValueOnce({ issues: [] });
    const service = new JiraProbeService(
      { register: vi.fn() } as unknown as IntegrationProbeRegistry,
      {
        fieldMappingVersion: {
          findFirst: vi.fn().mockResolvedValue({ id: 'mapping-1', versionNo: 1 }),
        },
      } as unknown as PrismaService,
      { get, searchPage } as unknown as JiraApiClient,
    );
    const result = await service.probe(target);

    expect(searchPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'post' }));
    expect(searchPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'get' }));
    expect(result).toMatchObject({ healthy: true, status: 'healthy' });
    expect(result.capabilities).toMatchObject({
      search: { post: false, getFallback: true, selectedMethod: 'get' },
      currentMappingVersionNo: 1,
    });
  });

  it('状态全集端点不可见时从搜索样例补全可配置状态', async () => {
    const get = vi.fn((_base: string, _credential: unknown, path: string) => {
      if (path === '/myself')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { accountId: 'u1', displayName: '用户' },
        });
      if (path === '/field')
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [{ id: 'status', name: '状态', schema: { type: 'status' } }],
        });
      if (path === '/project') return Promise.resolve({ status: 200, headers: {}, body: [] });
      return Promise.reject(new DomainError('JIRA_RESOURCE_NOT_VISIBLE', '端点不可见'));
    });
    const searchPage = vi.fn().mockResolvedValue({
      issues: [
        {
          id: '1',
          key: 'PROJ-1',
          fields: {
            status: {
              id: 3,
              name: '进行中',
              statusCategory: { key: 'indeterminate', name: '进行中' },
            },
          },
        },
      ],
    });
    const service = new JiraProbeService(
      { register: vi.fn() } as unknown as IntegrationProbeRegistry,
      {
        fieldMappingVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { get, searchPage } as unknown as JiraApiClient,
    );

    const result = await service.probe(target);

    expect(result.capabilities.statuses).toEqual([
      {
        id: '3',
        name: '进行中',
        categoryKey: 'indeterminate',
        categoryName: '进行中',
      },
    ]);
  });

  it('401 与 403 分别归为无效凭证/权限不足且不回显 Token', async () => {
    for (const code of ['JIRA_CREDENTIAL_INVALID', 'JIRA_PERMISSION_DENIED']) {
      const service = new JiraProbeService(
        { register: vi.fn() } as unknown as IntegrationProbeRegistry,
        {} as PrismaService,
        {
          get: vi.fn().mockRejectedValue(new DomainError(code, '访问失败')),
        } as unknown as JiraApiClient,
      );
      const result = await service.probe(target);
      expect(result).toMatchObject({ healthy: false, status: 'invalid', errorCode: code });
      expect(JSON.stringify(result)).not.toContain('fixture-token');
    }
  });
});
