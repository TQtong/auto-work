import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@auto-work/contracts';
import type { GitLabApiClient } from '../src/modules/gitlab/gitlab-api.client.js';
import { GitLabProbeService } from '../src/modules/gitlab/gitlab-probe.service.js';
import { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';

const target = {
  id: 'connection-1',
  type: 'gitlab' as const,
  baseUrl: 'https://git.example.com',
  config: { projectRefs: ['Group/Project'] },
  credential: { token: 'token-value' },
};

describe('GitLab 能力探测', () => {
  it('版本端点不可见时仍用当前用户和项目可见性确认真实能力', async () => {
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ status: 404, body: {}, headers: {} })
        .mockResolvedValueOnce({
          status: 200,
          body: { id: 9, username: 'tester', name: '测试用户', extra: '兼容新增字段' },
          headers: {},
        }),
      resolveProject: vi.fn().mockResolvedValue({
        id: 88,
        name: 'Project',
        path_with_namespace: 'Group/Project',
        web_url: 'https://git.example.com/Group/Project',
        visibility: 'private',
      }),
    } as unknown as GitLabApiClient;
    const registry = new IntegrationProbeRegistry();
    const probe = new GitLabProbeService(registry, client);
    probe.onModuleInit();

    const result = await registry.probe(target);
    expect(result).toMatchObject({
      healthy: true,
      status: 'healthy',
      identity: { id: '9', username: 'tester' },
      capabilities: { authenticated: true, versionEndpointVisible: false },
    });
  });

  it('明确区分无配置和无效凭证', async () => {
    const registry = new IntegrationProbeRegistry();
    const client = {
      get: vi.fn().mockRejectedValue(new DomainError('GITLAB_CREDENTIAL_INVALID', '凭证无效')),
    } as unknown as GitLabApiClient;
    const probe = new GitLabProbeService(registry, client);
    probe.onModuleInit();

    await expect(registry.probe({ ...target, credential: null })).resolves.toMatchObject({
      status: 'configuration_required',
    });
    await expect(registry.probe(target)).resolves.toMatchObject({
      status: 'invalid',
      errorCode: 'GITLAB_CREDENTIAL_INVALID',
    });
  });
});
