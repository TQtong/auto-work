import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import type { IntegrationConnection } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { EvidenceMaterializerService } from '../evidence/evidence-materializer.service.js';
import { GitLabApiClient } from './gitlab-api.client.js';
import {
  gitlabBranchSchema,
  gitlabCommitSchema,
  gitlabMemberSchema,
  gitlabMergeRequestSchema,
  gitlabPipelineSchema,
  gitlabProjectSchema,
  gitlabReleaseSchema,
  gitlabTagSchema,
} from './gitlab.schemas.js';

interface SyncCounts {
  projects: number;
  branches: number;
  commits: number;
  mergeRequests: number;
  pipelines: number;
  tags: number;
  releases: number;
  members: number;
}

@Injectable()
export class GitLabSyncService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly client: GitLabApiClient,
    private readonly evidenceMaterializer: EvidenceMaterializerService,
  ) {}

  public async sync(
    connection: IntegrationConnection,
    token: string,
    reportProgress: (value: number) => Promise<void>,
  ) {
    if (!connection.baseUrl || !connection.enabled) {
      throw new DomainError('GITLAB_CONNECTION_DISABLED', 'GitLab 连接未启用或缺少基础地址', {
        httpStatus: 409,
      });
    }
    const config = JSON.parse(connection.configJson) as Record<string, unknown>;
    const references = await this.resolveReferences(connection.id, connection.baseUrl, config);
    // 空范围是合法同步：它会在成功运行中失效已移出配置的旧项目，而不是留下永久陈旧缓存。
    const runId = newId();
    const counts: SyncCounts = {
      projects: 0,
      branches: 0,
      commits: 0,
      mergeRequests: 0,
      pipelines: 0,
      tags: 0,
      releases: 0,
      members: 0,
    };
    await this.prisma.gitLabSyncRun.create({
      data: {
        id: runId,
        connectionId: connection.id,
        status: 'running',
        scopeJson: JSON.stringify({ references }),
        startedAt: new Date(),
      },
    });
    const synchronizedProjects = new Set<string>();
    const completedProjectIds = new Set<string>();
    const projectErrors: Array<{
      reference: string;
      code: string;
      message: string;
      retryable: boolean;
    }> = [];
    try {
      for (const [index, reference] of references.entries()) {
        try {
          const project = gitlabProjectSchema.parse(
            await this.client.resolveProject(connection.baseUrl, token, reference),
          );
          const externalId = String(project.id);
          if (synchronizedProjects.has(externalId)) continue;
          synchronizedProjects.add(externalId);
          const existingProject = await this.prisma.gitLabProject.findUnique({
            where: { connectionId_externalId: { connectionId: connection.id, externalId } },
            select: { syncedAt: true },
          });
          const cachedProject = await this.prisma.gitLabProject.upsert({
            where: { connectionId_externalId: { connectionId: connection.id, externalId } },
            create: {
              id: newId(),
              connectionId: connection.id,
              externalId,
              pathWithNamespace: project.path_with_namespace,
              name: project.name,
              webUrl: project.web_url,
              defaultBranch: project.default_branch ?? null,
              visibility: project.visibility,
              archived: project.archived,
              lastActivityAt: this.date(project.last_activity_at),
              namespaceJson: JSON.stringify(project.namespace ?? {}),
              lastSeenRunId: runId,
              syncStatus: 'refreshing',
              syncedAt: null,
            },
            update: {
              pathWithNamespace: project.path_with_namespace,
              name: project.name,
              webUrl: project.web_url,
              defaultBranch: project.default_branch ?? null,
              visibility: project.visibility,
              archived: project.archived,
              lastActivityAt: this.date(project.last_activity_at),
              namespaceJson: JSON.stringify(project.namespace ?? {}),
              lastSeenRunId: runId,
              stale: false,
              syncStatus: 'refreshing',
              syncError: null,
            },
          });
          counts.projects += 1;
          await this.syncProjectResources(
            connection.baseUrl,
            token,
            externalId,
            cachedProject.id,
            runId,
            Number(config.historyDays ?? 120),
            existingProject?.syncedAt ?? null,
            counts,
          );
          await this.prisma.gitLabProject.update({
            where: { id: cachedProject.id },
            data: { syncStatus: 'fresh', syncError: null, syncedAt: new Date() },
          });
          completedProjectIds.add(cachedProject.id);
        } catch (error) {
          const domainError = error instanceof DomainError ? error : null;
          // 连接级失败继续请求其他项目只会放大限频或无效凭证问题，直接交给作业恢复策略。
          if (
            domainError &&
            [
              'GITLAB_CREDENTIAL_INVALID',
              'GITLAB_RATE_LIMITED',
              'GITLAB_RESPONSE_ERROR',
              'EXTERNAL_DNS_FAILED',
              'EXTERNAL_DNS_EMPTY',
              'EXTERNAL_ADDRESS_REJECTED',
              'EXTERNAL_REQUEST_TIMEOUT',
              'EXTERNAL_REQUEST_FAILED',
            ].includes(domainError.code)
          ) {
            throw error;
          }
          projectErrors.push({
            reference: String(reference),
            code: domainError?.code ?? 'GITLAB_PROJECT_SYNC_FAILED',
            message: (error instanceof Error ? error.message : '未知项目同步错误').slice(0, 500),
            retryable: domainError?.options.retryable ?? false,
          });
        } finally {
          await reportProgress(Math.round(((index + 1) / Math.max(references.length, 1)) * 95));
        }
      }
      if (projectErrors.length > 0) {
        throw new DomainError(
          'GITLAB_PROJECT_SYNC_PARTIAL_FAILED',
          `${projectErrors.length} 个 GitLab 项目同步失败，其余项目已完成`,
          {
            httpStatus: 502,
            retryable: projectErrors.some((error) => error.retryable),
            details: { projectErrors: projectErrors.slice(0, 20) },
          },
        );
      }
      // 当前配置范围已完整成功后，才将不再出现的项目标记为失效，避免失败同步污染旧快照。
      await this.prisma.gitLabProject.updateMany({
        where: { connectionId: connection.id, lastSeenRunId: { not: runId } },
        data: { stale: true },
      });
      await this.prisma.gitLabSyncRun.update({
        where: { id: runId },
        data: { status: 'succeeded', countsJson: JSON.stringify(counts), completedAt: new Date() },
      });
      await this.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: { status: 'healthy', lastSuccessAt: new Date(), version: { increment: 1 } },
      });
      // 只有 GitLab 缓存范围完整成功后才重建证据，失败页不会让旧建议错误过期。
      const evidence = await this.evidenceMaterializer.refreshConnection(connection.id);
      await reportProgress(100);
      return { runId, counts, evidence };
    } catch (error) {
      const domainError = error as DomainError;
      const errorSummary = domainError.message.slice(0, 1_000);
      // 只标记本轮已接触的项目；其子资源仍保留最后一次完整成功的缓存。
      await this.prisma.gitLabProject.updateMany({
        where: {
          connectionId: connection.id,
          lastSeenRunId: runId,
          id: { notIn: [...completedProjectIds] },
        },
        data: { syncStatus: 'error', syncError: errorSummary },
      });
      await this.prisma.gitLabSyncRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          countsJson: JSON.stringify(counts),
          errorCode: domainError.code ?? 'GITLAB_SYNC_FAILED',
          errorSummary,
          completedAt: new Date(),
        },
      });
      await this.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: {
          status: ['GITLAB_CREDENTIAL_INVALID', 'GITLAB_PERMISSION_DENIED'].includes(
            domainError.code,
          )
            ? 'invalid'
            : 'degraded',
          version: { increment: 1 },
        },
      });
      throw error;
    }
  }

  private async resolveReferences(
    connectionId: string,
    baseUrl: string,
    config: Record<string, unknown>,
  ) {
    const references = new Set<string | number>();
    const connectionUrl = new URL(baseUrl);
    const hostname = connectionUrl.hostname.toLowerCase();
    const port = connectionUrl.port ? Number(connectionUrl.port) : null;
    const repositories = await this.prisma.repository.findMany({
      where: { whitelistStatus: 'confirmed', remoteHost: hostname },
      select: {
        gitlabConnectionId: true,
        gitlabProjectRef: true,
        remotePath: true,
        remotePort: true,
      },
    });
    // 已人工确认的稳定 project ID 优先于可变路径，用于识别 GitLab 项目重命名。
    for (const repository of repositories) {
      if (
        repository.gitlabConnectionId === connectionId &&
        repository.gitlabProjectRef &&
        repository.remotePort === port
      )
        references.add(repository.gitlabProjectRef);
    }
    for (const value of Array.isArray(config.projectIds) ? config.projectIds : []) {
      if (typeof value === 'number' || typeof value === 'string') references.add(value);
    }
    for (const value of Array.isArray(config.projectRefs) ? config.projectRefs : []) {
      if (typeof value === 'number' || typeof value === 'string') references.add(value);
    }
    for (const repository of repositories) {
      if (
        (!repository.gitlabConnectionId || repository.gitlabConnectionId === connectionId) &&
        repository.remotePath &&
        repository.remotePort === port
      )
        references.add(repository.remotePath);
    }
    return [...references];
  }

  private async syncProjectResources(
    baseUrl: string,
    token: string,
    externalProjectId: string,
    projectId: string,
    runId: string,
    historyDays: number,
    previousSuccessfulSyncAt: Date | null,
    counts: SyncCounts,
  ) {
    const root = this.client.projectPath(externalProjectId);
    const historyFloor = Date.now() - Math.min(Math.max(historyDays, 1), 730) * 86_400_000;
    // 成功水位向前重叠十五分钟，兼容同一时间戳、时钟漂移和短暂分页变化。
    const watermarkFloor = previousSuccessfulSyncAt
      ? previousSuccessfulSyncAt.getTime() - 15 * 60_000
      : historyFloor;
    const since = new Date(Math.max(historyFloor, watermarkFloor)).toISOString();
    const [branches, commits, mergeRequests, pipelines, tags, releases, members] =
      await Promise.all([
        this.client.list(baseUrl, token, `${root}/repository/branches`),
        this.client.list(baseUrl, token, `${root}/repository/commits`, { since }),
        this.client.list(baseUrl, token, `${root}/merge_requests`, {
          state: 'all',
          updated_after: since,
        }),
        this.client.list(baseUrl, token, `${root}/pipelines`, { updated_after: since }),
        this.client.list(baseUrl, token, `${root}/repository/tags`),
        this.client.list(baseUrl, token, `${root}/releases`),
        this.client.list(baseUrl, token, `${root}/members/all`),
      ]);
    // 所有分页响应先完成结构校验，任意一页畸形时都不会开始覆盖已有缓存。
    const validated = {
      branches: branches.map((item) => gitlabBranchSchema.parse(item)),
      commits: commits.map((item) => gitlabCommitSchema.parse(item)),
      mergeRequests: mergeRequests.map((item) => gitlabMergeRequestSchema.parse(item)),
      pipelines: pipelines.map((item) => gitlabPipelineSchema.parse(item)),
      tags: tags.map((item) => gitlabTagSchema.parse(item)),
      releases: releases.map((item) => gitlabReleaseSchema.parse(item)),
      members: members.map((item) => gitlabMemberSchema.parse(item)),
    };
    await this.saveBranches(projectId, runId, validated.branches);
    await this.saveCommits(projectId, runId, validated.commits);
    await this.saveMergeRequests(projectId, runId, validated.mergeRequests);
    await this.savePipelines(projectId, runId, validated.pipelines);
    await this.saveTags(projectId, runId, validated.tags);
    await this.saveReleases(projectId, runId, validated.releases);
    await this.saveMembers(projectId, runId, validated.members);
    counts.branches += branches.length;
    counts.commits += commits.length;
    counts.mergeRequests += mergeRequests.length;
    counts.pipelines += pipelines.length;
    counts.tags += tags.length;
    counts.releases += releases.length;
    counts.members += members.length;
  }

  private async saveBranches(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabBranchSchema.parse(value);
      await this.prisma.gitLabBranch.upsert({
        where: { gitlabProjectId_name: { gitlabProjectId: projectId, name: item.name } },
        create: {
          id: newId(),
          gitlabProjectId: projectId,
          name: item.name,
          sha: item.commit.id,
          protected: item.protected,
          defaultBranch: item.default,
          merged: item.merged,
          webUrl: item.web_url ?? null,
          lastSeenRunId: runId,
          syncedAt: new Date(),
        },
        update: {
          sha: item.commit.id,
          protected: item.protected,
          defaultBranch: item.default,
          merged: item.merged,
          webUrl: item.web_url ?? null,
          lastSeenRunId: runId,
          stale: false,
          syncedAt: new Date(),
        },
      });
    }
    await this.prisma.gitLabBranch.updateMany({
      where: { gitlabProjectId: projectId, lastSeenRunId: { not: runId } },
      data: { stale: true },
    });
  }

  private async saveCommits(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabCommitSchema.parse(value);
      const data = {
        shortSha: item.short_id ?? null,
        title: item.title.slice(0, 1_000),
        messageSummary: item.message.slice(0, 4_000),
        authorName: item.author_name,
        authorEmail: item.author_email,
        committerName: item.committer_name ?? null,
        committerEmail: item.committer_email ?? null,
        authoredAt: this.date(item.authored_date),
        committedAt: new Date(item.committed_date),
        webUrl: item.web_url ?? null,
        lastSeenRunId: runId,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabCommit.upsert({
        where: { gitlabProjectId_sha: { gitlabProjectId: projectId, sha: item.id } },
        create: { id: newId(), gitlabProjectId: projectId, sha: item.id, ...data },
        update: data,
      });
    }
  }

  private async saveMergeRequests(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabMergeRequestSchema.parse(value);
      const externalId = String(item.id);
      const data = {
        iid: item.iid,
        title: item.title.slice(0, 2_000),
        state: item.state,
        sourceBranch: item.source_branch,
        targetBranch: item.target_branch,
        authorJson: JSON.stringify(this.identitySummary(item.author)),
        assigneesJson: JSON.stringify(item.assignees.map((entry) => this.identitySummary(entry))),
        draft: item.draft ?? item.work_in_progress ?? false,
        mergedAt: this.date(item.merged_at),
        closedAt: this.date(item.closed_at),
        updatedExternalAt: new Date(item.updated_at),
        webUrl: item.web_url,
        lastSeenRunId: runId,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabMergeRequest.upsert({
        where: { gitlabProjectId_externalId: { gitlabProjectId: projectId, externalId } },
        create: { id: newId(), gitlabProjectId: projectId, externalId, ...data },
        update: data,
      });
    }
  }

  private async savePipelines(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabPipelineSchema.parse(value);
      const externalId = String(item.id);
      const data = {
        iid: item.iid ?? null,
        sha: item.sha,
        ref: item.ref ?? null,
        status: item.status,
        source: item.source ?? null,
        webUrl: item.web_url ?? null,
        createdExternalAt: this.date(item.created_at),
        updatedExternalAt: this.date(item.updated_at),
        lastSeenRunId: runId,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabPipeline.upsert({
        where: { gitlabProjectId_externalId: { gitlabProjectId: projectId, externalId } },
        create: { id: newId(), gitlabProjectId: projectId, externalId, ...data },
        update: data,
      });
    }
  }

  private async saveTags(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabTagSchema.parse(value);
      const data = {
        targetSha: item.commit?.id ?? item.target,
        messageSummary: item.message?.slice(0, 4_000) ?? null,
        protected: item.protected,
        webUrl: item.web_url ?? null,
        createdExternalAt: this.date(item.created_at),
        lastSeenRunId: runId,
        stale: false,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabTag.upsert({
        where: { gitlabProjectId_name: { gitlabProjectId: projectId, name: item.name } },
        create: { id: newId(), gitlabProjectId: projectId, name: item.name, ...data },
        update: data,
      });
    }
    await this.prisma.gitLabTag.updateMany({
      where: { gitlabProjectId: projectId, lastSeenRunId: { not: runId } },
      data: { stale: true },
    });
  }

  private async saveReleases(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabReleaseSchema.parse(value);
      const data = {
        name: item.name ?? null,
        descriptionSummary: item.description?.slice(0, 8_000) ?? null,
        releasedAt: this.date(item.released_at),
        createdExternalAt: this.date(item.created_at),
        upcomingRelease: item.upcoming_release,
        webUrl: item._links?.self ?? null,
        assetsJson: JSON.stringify(item.assets ?? {}),
        lastSeenRunId: runId,
        stale: false,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabRelease.upsert({
        where: { gitlabProjectId_tagName: { gitlabProjectId: projectId, tagName: item.tag_name } },
        create: { id: newId(), gitlabProjectId: projectId, tagName: item.tag_name, ...data },
        update: data,
      });
    }
    await this.prisma.gitLabRelease.updateMany({
      where: { gitlabProjectId: projectId, lastSeenRunId: { not: runId } },
      data: { stale: true },
    });
  }

  private async saveMembers(projectId: string, runId: string, values: unknown[]) {
    for (const value of values) {
      const item = gitlabMemberSchema.parse(value);
      const externalUserId = String(item.id);
      const data = {
        username: item.username,
        name: item.name,
        state: item.state ?? null,
        accessLevel: item.access_level,
        webUrl: item.web_url ?? null,
        avatarUrl: item.avatar_url ?? null,
        expiresAt: item.expires_at ? new Date(`${item.expires_at}T00:00:00.000Z`) : null,
        lastSeenRunId: runId,
        stale: false,
        syncedAt: new Date(),
      };
      await this.prisma.gitLabProjectMember.upsert({
        where: { gitlabProjectId_externalUserId: { gitlabProjectId: projectId, externalUserId } },
        create: { id: newId(), gitlabProjectId: projectId, externalUserId, ...data },
        update: data,
      });
    }
    await this.prisma.gitLabProjectMember.updateMany({
      where: { gitlabProjectId: projectId, lastSeenRunId: { not: runId } },
      data: { stale: true },
    });
  }

  private date(value: string | null | undefined): Date | null {
    return value ? new Date(value) : null;
  }

  private identitySummary(value: unknown) {
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      ['id', 'username', 'name', 'web_url'].flatMap((key) =>
        ['string', 'number'].includes(typeof record[key]) ? [[key, record[key]]] : [],
      ),
    );
  }
}
