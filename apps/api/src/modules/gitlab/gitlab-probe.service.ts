import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { GitLabApiClient } from './gitlab-api.client.js';
import { gitlabProjectSchema, gitlabUserSchema, gitlabVersionSchema } from './gitlab.schemas.js';

@Injectable()
export class GitLabProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'gitlab' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly client: GitLabApiClient,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    if (!target.baseUrl || !target.credential?.token) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: { adapterRegistered: true, authenticated: false },
        errorCode: 'GITLAB_CONFIGURATION_REQUIRED',
        message: 'GitLab 基础地址和 Token 均为必填项',
      };
    }
    try {
      const versionResponse = await this.client.get(
        target.baseUrl,
        target.credential.token,
        '/version',
        {},
        [200, 401, 403, 404],
      );
      const userResponse = await this.client.get(target.baseUrl, target.credential.token, '/user');
      const user = gitlabUserSchema.parse(userResponse.body);
      const version =
        versionResponse.status === 200 ? gitlabVersionSchema.safeParse(versionResponse.body) : null;
      const references = this.configuredReferences(target.config);
      const projectChecks: Array<{ reference: string; accessible: boolean; projectId?: string }> =
        [];
      for (const reference of references.slice(0, 20)) {
        try {
          const project = gitlabProjectSchema.parse(
            await this.client.resolveProject(target.baseUrl, target.credential.token, reference),
          );
          projectChecks.push({
            reference: String(reference),
            accessible: true,
            projectId: String(project.id),
          });
        } catch (error) {
          if ((error as DomainError).code === 'GITLAB_RESOURCE_NOT_VISIBLE') {
            projectChecks.push({ reference: String(reference), accessible: false });
            continue;
          }
          throw error;
        }
      }
      const inaccessibleCount = projectChecks.filter((item) => !item.accessible).length;
      return {
        healthy: inaccessibleCount === 0,
        status: inaccessibleCount === 0 ? 'healthy' : 'degraded',
        identity: {
          id: String(user.id),
          username: user.username,
          name: user.name,
          email: user.email ?? user.public_email ?? null,
        },
        capabilities: {
          adapterRegistered: true,
          authenticated: true,
          apiVersion: version?.success ? version.data.version : null,
          apiRevision: version?.success ? (version.data.revision ?? null) : null,
          versionEndpointVisible: versionResponse.status === 200,
          pagination: { link: true, xNextPageFallback: true, perPage: 100 },
          readResources: [
            'project',
            'branch',
            'commit',
            'merge_request',
            'pipeline',
            'tag',
            'release',
            'project_member',
          ],
          forbiddenResources: ['repository_file', 'diff', 'job_log', 'variable'],
          configuredProjectCount: references.length,
          projectCheckLimit: 20,
          uncheckedProjectCount: Math.max(references.length - projectChecks.length, 0),
          projectChecks,
        },
        ...(inaccessibleCount > 0
          ? {
              errorCode: 'GITLAB_PROJECT_PARTIALLY_VISIBLE',
              message: `${inaccessibleCount} 个配置项目不可见`,
            }
          : {}),
      };
    } catch (error) {
      const domainError = error as DomainError;
      return {
        healthy: false,
        status: ['GITLAB_CREDENTIAL_INVALID', 'GITLAB_PERMISSION_DENIED'].includes(domainError.code)
          ? 'invalid'
          : 'degraded',
        capabilities: { adapterRegistered: true, authenticated: false },
        errorCode: domainError.code ?? 'GITLAB_PROBE_FAILED',
        message: domainError.message,
      };
    }
  }

  private configuredReferences(config: Record<string, unknown>): Array<string | number> {
    const values: unknown[] = [];
    if (Array.isArray(config.projectIds)) values.push(...(config.projectIds as unknown[]));
    if (Array.isArray(config.projectRefs)) values.push(...(config.projectRefs as unknown[]));
    return values.filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    );
  }
}
