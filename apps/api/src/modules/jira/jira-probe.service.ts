import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { JiraApiClient, type JiraCredential } from './jira-api.client.js';
import {
  jiraFieldSchema,
  jiraProjectSchema,
  jiraStatusSchema,
  jiraUserSchema,
} from './jira.schemas.js';

@Injectable()
export class JiraProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'jira' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly prisma: PrismaService,
    private readonly client: JiraApiClient,
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
        errorCode: 'JIRA_CONFIGURATION_REQUIRED',
        message: 'Jira 基础地址和 Token 均为必填项',
      };
    }
    const credential = this.credential(target);
    try {
      // 探测顺序固定为身份、字段、项目、搜索；状态全集是完成基础探测后的附加只读能力。
      const user = jiraUserSchema.parse(
        (await this.client.get(target.baseUrl, credential, '/myself')).body,
      );
      const fieldsBody = (await this.client.get(target.baseUrl, credential, '/field')).body;
      const projectsBody = (await this.client.get(target.baseUrl, credential, '/project')).body;
      if (!Array.isArray(fieldsBody) || !Array.isArray(projectsBody)) {
        throw new DomainError('JIRA_DISCOVERY_INVALID', 'Jira 字段或项目端点返回结构无效', {
          httpStatus: 502,
        });
      }
      const fields = fieldsBody.map((item) => jiraFieldSchema.parse(item));
      const projects = projectsBody.map((item) => jiraProjectSchema.parse(item));
      let searchMethod: 'post' | 'get' = 'post';
      let sample;
      try {
        sample = await this.client.searchPage({
          baseUrl: target.baseUrl,
          credential,
          jql: 'assignee = currentUser() ORDER BY updated DESC',
          fields: ['*navigable'],
          startAt: 0,
          maxResults: 20,
          method: 'post',
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'JIRA_POST_SEARCH_UNSUPPORTED') {
          throw error;
        }
        searchMethod = 'get';
        sample = await this.client.searchPage({
          baseUrl: target.baseUrl,
          credential,
          jql: 'assignee = currentUser() ORDER BY updated DESC',
          fields: ['*navigable'],
          startAt: 0,
          maxResults: 20,
          method: 'get',
        });
      }
      const statusBody = await this.client
        .get(target.baseUrl, credential, '/status')
        .then((response) => response.body)
        .catch((error) => {
          if (error instanceof DomainError && error.code === 'JIRA_RESOURCE_NOT_VISIBLE') return [];
          throw error;
        });
      const statusesById = new Map(
        (Array.isArray(statusBody) ? statusBody : []).map((item) => {
          const status = jiraStatusSchema.parse(item);
          return [status.id, status] as const;
        }),
      );
      // 部分 Jira 部署会禁止 /status，但搜索结果仍携带调用方可见的状态；合并样例状态可避免配置界面无从建立映射。
      for (const issue of sample.issues) {
        const parsed = jiraStatusSchema.safeParse(issue.fields.status);
        if (parsed.success && !statusesById.has(parsed.data.id)) {
          statusesById.set(parsed.data.id, parsed.data);
        }
      }
      const statuses = [...statusesById.values()].sort((left, right) =>
        left.name.localeCompare(right.name, 'zh-CN'),
      );
      const latestMapping = await this.prisma.fieldMappingVersion.findFirst({
        where: { connectionId: target.id },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true },
      });
      const fieldSummaries = fields.map((field) => {
        const values = sample.issues
          .map((issue) => issue.fields[field.id])
          .filter((value) => value !== null && value !== undefined);
        return {
          id: field.id,
          name: field.name,
          custom: field.custom ?? false,
          schema: field.schema ?? null,
          occurrenceRate: sample.issues.length === 0 ? 0 : values.length / sample.issues.length,
          sampleValues: values.slice(0, 3).map((value) => this.sampleValue(value)),
        };
      });
      const configurationReady = Boolean(latestMapping);
      return {
        healthy: configurationReady,
        status: configurationReady ? 'healthy' : 'configuration_required',
        identity: {
          id: user.accountId ?? user.key ?? user.name ?? user.displayName,
          username: user.name ?? user.key ?? user.accountId ?? user.displayName,
          name: user.displayName,
          email: user.emailAddress ?? null,
        },
        capabilities: {
          adapterRegistered: true,
          authenticated: true,
          identity: {
            id: user.accountId ?? user.key ?? user.name ?? user.displayName,
            username: user.name ?? user.key ?? user.accountId ?? user.displayName,
            name: user.displayName,
          },
          search: {
            post: searchMethod === 'post',
            getFallback: true,
            selectedMethod: searchMethod,
          },
          fields: fieldSummaries,
          projects: projects.map((project) => ({
            id: project.id,
            key: project.key,
            name: project.name,
            projectTypeKey: project.projectTypeKey ?? null,
            archived: project.archived ?? false,
          })),
          statuses: statuses.map((status) => ({
            id: status.id,
            name: status.name,
            categoryKey: status.statusCategory?.key ?? null,
            categoryName: status.statusCategory?.name ?? null,
          })),
          sampleIssueCount: sample.issues.length,
          sampleTotal: sample.total ?? sample.issues.length,
          currentMappingVersionId: latestMapping?.id ?? null,
          currentMappingVersionNo: latestMapping?.versionNo ?? null,
          descriptionPersisted: false,
          readOnly: true,
        },
        ...(configurationReady
          ? {}
          : {
              errorCode: 'JIRA_MAPPING_REQUIRED',
              message: '身份和搜索已验证，请确认字段与状态映射',
            }),
      };
    } catch (error) {
      const domainError = error instanceof DomainError ? error : null;
      return {
        healthy: false,
        status: ['JIRA_CREDENTIAL_INVALID', 'JIRA_PERMISSION_DENIED'].includes(
          domainError?.code ?? '',
        )
          ? 'invalid'
          : 'degraded',
        capabilities: { adapterRegistered: true, authenticated: false, readOnly: true },
        errorCode: domainError?.code ?? 'JIRA_PROBE_FAILED',
        message: (error instanceof Error ? error.message : 'Jira 能力探测失败').slice(0, 500),
      };
    }
  }

  private credential(target: ProbeTarget): JiraCredential {
    const authScheme = target.config.authScheme === 'basic_pat' ? 'basic_pat' : 'bearer';
    return {
      token: target.credential!.token!,
      authScheme,
      ...(authScheme === 'basic_pat' && typeof target.config.accountName === 'string'
        ? { accountName: target.config.accountName }
        : {}),
    };
  }

  private sampleValue(value: unknown): unknown {
    if (typeof value === 'string') return value.slice(0, 200);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 3).map((item) => this.sampleValue(item));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        ['id', 'key', 'name', 'value', 'displayName'].flatMap((key) =>
          record[key] === undefined ? [] : [[key, this.sampleValue(record[key])]],
        ),
      );
    }
    return null;
  }
}
