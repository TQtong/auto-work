import { Injectable } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import type { GitSnapshot, Prisma, Project, Repository } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { deriveGitLabFreshness } from '../gitlab/gitlab-freshness.js';
import { RepositoryInspectorService } from './repository-inspector.service.js';
import type { DiscoveryWarning, RepositoryIdentity } from './repository.types.js';

type RepositoryViewSource = Repository & {
  project?: Project | null;
  snapshots?: GitSnapshot[];
};

const taskStatuses = ['planned', 'in_progress', 'blocked', 'done', 'cancelled', 'other'] as const;

@Injectable()
export class RepositoryService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly inspector: RepositoryInspectorService,
  ) {}

  public async discover(includeMissingCheck: boolean) {
    const root = await this.inspector.canonicalRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const warnings: DiscoveryWarning[] = [];
    const repositories: Array<ReturnType<RepositoryService['toRepositoryView']>> = [];
    const seenPaths = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) {
          warnings.push({
            directory: entry.name,
            code: 'REPARSE_POINT_SKIPPED',
            message: '重解析点不会作为仓库候选，避免路径逃逸',
          });
        }
        continue;
      }
      const candidatePath = resolve(root, entry.name);
      try {
        const identity = await this.inspector.inspect(candidatePath, root);
        seenPaths.add(identity.canonicalPath.toLowerCase());
        const repository = await this.upsertObservation(identity);
        // 发现阶段只读取仓库身份并完成登记，不同步执行可能很慢的完整工作区状态扫描。
        // Docker Desktop bind mount 上大型仓库的 git status 可能需要数分钟；它应由独立刷新作业处理，
        // 不能让已经识别成功的仓库在发现报告中被误写成“跳过”。
        repositories.push(this.toRepositoryView({ ...repository, snapshots: [] }));
      } catch (error) {
        const domainError = error as DomainError;
        warnings.push({
          directory: entry.name,
          code: domainError.code ?? 'REPOSITORY_DISCOVERY_FAILED',
          message: domainError.message,
        });
      }
    }

    if (includeMissingCheck) {
      const registered = await this.prisma.repository.findMany();
      for (const repository of registered) {
        const underRoot = repository.canonicalPath
          .toLowerCase()
          .startsWith(`${root.toLowerCase()}${sep}`);
        if (underRoot && !seenPaths.has(repository.canonicalPath.toLowerCase())) {
          await this.prisma.repository.update({
            where: { id: repository.id },
            data: {
              whitelistStatus: 'missing',
              statusReason: '本次一级目录扫描未发现该仓库',
            },
          });
        }
      }
    }

    return { root, repositories, warnings, scannedDirectoryCount: entries.length };
  }

  public async refresh(repositoryId: string) {
    const repository = await this.prisma.repository.findUnique({ where: { id: repositoryId } });
    if (!repository) throw new DomainError(errorCodes.notFound, '仓库不存在', { httpStatus: 404 });
    if (repository.whitelistStatus === 'disabled') {
      throw new DomainError('REPOSITORY_DISABLED', '仓库已移出本机白名单', { httpStatus: 409 });
    }
    const identity = await this.inspector.inspect(repository.canonicalPath);
    if (identity.identityHash !== repository.identityHash) {
      await this.prisma.repository.update({
        where: { id: repository.id },
        data: {
          whitelistStatus: 'needs_review',
          statusReason: '路径中的 Git 元数据身份已变化，必须重新确认',
          identityHash: identity.identityHash,
          realPathHash: identity.realPathHash,
          version: { increment: 1 },
        },
      });
      throw new DomainError('REPOSITORY_IDENTITY_CHANGED', '仓库身份已变化，必须重新确认', {
        httpStatus: 412,
        suggestedAction: 'reconfirm',
      });
    }
    const snapshot = await this.collectAndPersistSnapshot(repository.id, repository.canonicalPath);
    return this.toRepositoryView({
      ...(await this.prisma.repository.findUniqueOrThrow({ where: { id: repository.id } })),
      snapshots: [snapshot],
    });
  }

  public async list() {
    const repositories = await this.prisma.repository.findMany({
      include: {
        project: true,
        snapshots: { orderBy: { collectedAt: 'desc' }, take: 1 },
      },
      orderBy: [{ whitelistStatus: 'asc' }, { displayName: 'asc' }],
    });
    const withGitLab = await this.attachGitLab(
      repositories.map((repository) => this.toRepositoryView(repository)),
    );
    return this.attachTaskSummaries(withGitLab);
  }

  public async get(id: string) {
    const repository = await this.prisma.repository.findUnique({
      where: { id },
      include: {
        project: true,
        snapshots: { orderBy: { collectedAt: 'desc' }, take: 20 },
      },
    });
    if (!repository) throw new DomainError(errorCodes.notFound, '仓库不存在', { httpStatus: 404 });
    const withGitLab = await this.attachGitLab([this.toRepositoryView(repository)]);
    return (await this.attachTaskSummaries(withGitLab))[0]!;
  }

  public async confirm(
    id: string,
    input: {
      displayName: string;
      alias?: string | null | undefined;
      projectId?: string | null | undefined;
      remoteName?: string | null | undefined;
      gitlabProjectRef?: string | null | undefined;
      baselineBranch: string;
      discoverySnapshotVersion: number;
    },
  ) {
    const repository = await this.prisma.repository.findUnique({ where: { id } });
    if (!repository) throw new DomainError(errorCodes.notFound, '仓库不存在', { httpStatus: 404 });
    if (repository.whitelistStatus === 'missing') {
      throw new DomainError(
        'REPOSITORY_PATH_UNAVAILABLE',
        '仓库目录当前不存在，不能加入白名单；请检查扫描目录后重新扫描',
        { httpStatus: 409, suggestedAction: 'refresh' },
      );
    }
    const identity = await this.inspector.inspect(repository.canonicalPath);
    if (identity.identityHash !== repository.identityHash) {
      throw new DomainError('REPOSITORY_IDENTITY_CHANGED', '仓库身份与发现快照不一致', {
        httpStatus: 412,
        suggestedAction: 'reconfirm',
      });
    }
    if (input.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
      if (!project || project.archivedAt)
        throw new DomainError('PROJECT_NOT_AVAILABLE', '指定项目不存在或已归档', {
          httpStatus: 422,
        });
    }
    const selectedRemote = input.remoteName
      ? identity.remotes.find((remote) => remote.name === input.remoteName)
      : identity.defaultRemote;
    if (input.remoteName && !selectedRemote) {
      throw new DomainError('REMOTE_NOT_FOUND', '所选远端已不存在', { httpStatus: 412 });
    }
    const gitlabProject = input.gitlabProjectRef
      ? await this.prisma.gitLabProject.findFirst({
          where: { id: input.gitlabProjectRef, stale: false },
          include: { connection: true },
        })
      : null;
    if (input.gitlabProjectRef) {
      const gitlabHost = gitlabProject?.connection.baseUrl
        ? new URL(gitlabProject.connection.baseUrl).hostname.toLowerCase()
        : null;
      const gitlabPort = gitlabProject?.connection.baseUrl
        ? this.normalizedUrlPort(new URL(gitlabProject.connection.baseUrl))
        : null;
      if (
        !gitlabProject ||
        gitlabHost !== selectedRemote?.host?.toLowerCase() ||
        gitlabPort !== (selectedRemote?.port ?? null) ||
        gitlabProject.pathWithNamespace !== selectedRemote?.path
      ) {
        throw new DomainError('GITLAB_PROJECT_MATCH_INVALID', 'GitLab 项目与所选远端不精确匹配', {
          httpStatus: 422,
        });
      }
    }
    const updated = await this.prisma.repository.updateMany({
      where: { id, version: input.discoverySnapshotVersion },
      data: {
        displayName: input.displayName,
        alias: input.alias ?? null,
        projectId: input.projectId ?? null,
        remoteName: selectedRemote?.name ?? null,
        remoteUrl: selectedRemote?.sanitizedUrl ?? null,
        remoteProtocol: selectedRemote?.protocol ?? null,
        remoteHost: selectedRemote?.host ?? null,
        remotePort: selectedRemote?.port ?? null,
        remotePath: selectedRemote?.path ?? null,
        gitlabConnectionId: gitlabProject?.connectionId ?? null,
        gitlabProjectRef: gitlabProject?.externalId ?? null,
        baselineBranch: input.baselineBranch,
        whitelistStatus: 'confirmed',
        statusReason: null,
        lastSeenAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new DomainError(errorCodes.versionConflict, '仓库发现快照已变化，请刷新后重新确认', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    return this.get(id);
  }

  public async update(
    id: string,
    input: {
      version: number;
      displayName?: string | undefined;
      alias?: string | null | undefined;
      projectId?: string | null | undefined;
      baselineBranch?: string | undefined;
    },
  ) {
    const { version, ...changes } = input;
    const data: Prisma.RepositoryUncheckedUpdateManyInput = { version: { increment: 1 } };
    if (changes.displayName !== undefined) data.displayName = changes.displayName;
    if (changes.alias !== undefined) data.alias = changes.alias;
    if (changes.projectId !== undefined) data.projectId = changes.projectId;
    if (changes.baselineBranch !== undefined) data.baselineBranch = changes.baselineBranch;
    const updated = await this.prisma.repository.updateMany({
      where: { id, version },
      data,
    });
    if (updated.count !== 1) {
      const exists = await this.prisma.repository.findUnique({
        where: { id },
        select: { id: true },
      });
      throw new DomainError(
        exists ? errorCodes.versionConflict : errorCodes.notFound,
        exists ? '仓库版本已变化' : '仓库不存在',
        {
          httpStatus: exists ? 409 : 404,
          suggestedAction: exists ? 'refresh' : 'none',
        },
      );
    }
    return this.get(id);
  }

  public async disable(id: string, version: number) {
    const updated = await this.prisma.repository.updateMany({
      where: { id, version },
      data: {
        whitelistStatus: 'disabled',
        statusReason: '用户已移出可写白名单',
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new DomainError(errorCodes.versionConflict, '仓库版本已变化或不存在', {
        httpStatus: 409,
      });
    return this.get(id);
  }

  public async createProject(input: {
    name: string;
    alias?: string | undefined;
    description?: string | undefined;
    jiraProjectKey?: string | undefined;
  }) {
    const data: Prisma.ProjectCreateInput = { id: newId(), name: input.name };
    if (input.alias !== undefined) data.alias = input.alias;
    if (input.description !== undefined) data.description = input.description;
    if (input.jiraProjectKey !== undefined) data.jiraProjectKey = input.jiraProjectKey;
    return this.prisma.project.create({
      data,
    });
  }

  public async updateProject(
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      alias?: string | null | undefined;
      description?: string | null | undefined;
      jiraProjectKey?: string | null | undefined;
    },
  ) {
    const { version, ...changes } = input;
    const data: Prisma.ProjectUpdateManyMutationInput = { version: { increment: 1 } };
    if (changes.name !== undefined) data.name = changes.name;
    if (changes.alias !== undefined) data.alias = changes.alias;
    if (changes.description !== undefined) data.description = changes.description;
    if (changes.jiraProjectKey !== undefined) data.jiraProjectKey = changes.jiraProjectKey;
    const result = await this.prisma.project.updateMany({
      where: { id, version },
      data,
    });
    if (result.count !== 1) {
      const exists = await this.prisma.project.findUnique({ where: { id }, select: { id: true } });
      throw new DomainError(
        exists ? errorCodes.versionConflict : errorCodes.notFound,
        exists ? '项目版本已变化，请刷新后重试' : '项目不存在',
        { httpStatus: exists ? 409 : 404 },
      );
    }
    return this.prisma.project.findUniqueOrThrow({ where: { id } });
  }

  public async listProjects(includeArchived: boolean) {
    const rows = await this.prisma.project.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: { _count: { select: { repositories: true, tasks: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      alias: row.alias,
      description: row.description,
      jiraProjectKey: row.jiraProjectKey,
      enabled: row.enabled,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      repositoryCount: row._count.repositories,
      taskCount: row._count.tasks,
      version: row.version,
    }));
  }

  private async upsertObservation(identity: RepositoryIdentity) {
    const existing = await this.prisma.repository.findUnique({
      where: { canonicalPath: identity.canonicalPath },
    });
    const remote = existing
      ? (identity.remotes.find((item) => item.name === existing.remoteName) ??
        identity.defaultRemote)
      : identity.defaultRemote;
    if (!existing) {
      return this.prisma.repository.create({
        data: {
          id: newId(),
          canonicalPath: identity.canonicalPath,
          realPathHash: identity.realPathHash,
          identityHash: identity.identityHash,
          displayName: identity.displayName,
          gitDirKind: identity.gitDirKind,
          remoteName: remote?.name ?? null,
          remoteUrl: remote?.sanitizedUrl ?? null,
          remoteProtocol: remote?.protocol ?? null,
          remoteHost: remote?.host ?? null,
          remotePort: remote?.port ?? null,
          remotePath: remote?.path ?? null,
          baselineBranch: identity.branchName,
          whitelistStatus: 'discovered',
          lastSeenAt: new Date(),
        },
      });
    }
    const identityChanged = existing.identityHash !== identity.identityHash;
    const gitlabRemoteChanged = Boolean(
      existing.gitlabProjectRef &&
      (existing.remoteHost?.toLowerCase() !== remote?.host?.toLowerCase() ||
        existing.remotePort !== (remote?.port ?? null) ||
        existing.remotePath !== remote?.path),
    );
    const needsReview = identityChanged || gitlabRemoteChanged;
    const restoredFromMissing = existing.whitelistStatus === 'missing' && !needsReview;
    const statusReason = identityChanged
      ? '相同路径中的 Git 元数据身份已变化'
      : gitlabRemoteChanged
        ? '已确认的远端主机、端口或项目路径发生变化，GitLab 匹配必须重新确认'
        : restoredFromMissing
          ? null
          : existing.statusReason;
    return this.prisma.repository.update({
      where: { id: existing.id },
      data: {
        realPathHash: identity.realPathHash,
        identityHash: identity.identityHash,
        gitDirKind: identity.gitDirKind,
        remoteName: remote?.name ?? existing.remoteName,
        remoteUrl: remote?.sanitizedUrl ?? null,
        remoteProtocol: remote?.protocol ?? null,
        remoteHost: remote?.host ?? null,
        remotePort: remote?.port ?? null,
        remotePath: remote?.path ?? null,
        lastSeenAt: new Date(),
        whitelistStatus: needsReview
          ? 'needs_review'
          : restoredFromMissing
            ? 'discovered'
            : existing.whitelistStatus,
        statusReason,
        ...(needsReview || restoredFromMissing ? { version: { increment: 1 } } : {}),
      },
    });
  }

  private async collectAndPersistSnapshot(repositoryId: string, repositoryPath: string) {
    const snapshot = await this.inspector.collectStatus(repositoryPath);
    const collectedAt = new Date();
    const created = await this.prisma.gitSnapshot.create({
      data: {
        id: newId(),
        repositoryId,
        headSha: snapshot.headSha,
        branchName: snapshot.branchName,
        detached: snapshot.detached,
        unborn: snapshot.unborn,
        upstreamRef: snapshot.upstreamRef,
        aheadCount: snapshot.aheadCount,
        behindCount: snapshot.behindCount,
        stagedCount: snapshot.stagedCount,
        unstagedCount: snapshot.unstagedCount,
        untrackedCount: snapshot.untrackedCount,
        conflictedCount: snapshot.conflictedCount,
        pathSummaryJson: JSON.stringify(snapshot.pathSummary),
        stashCount: snapshot.stashCount,
        recentCommitJson: JSON.stringify(snapshot.recentCommit ?? {}),
        remotesJson: JSON.stringify(snapshot.remotes),
        collectedAt,
      },
    });
    await this.prisma.repository.update({
      where: { id: repositoryId },
      data: { lastSeenAt: collectedAt, lastLocalRefreshAt: collectedAt },
    });
    return created;
  }

  private toRepositoryView(repository: RepositoryViewSource) {
    const latest = repository.snapshots?.[0];
    const collectedAt = latest?.collectedAt;
    const freshness = !collectedAt
      ? 'unknown'
      : Date.now() - collectedAt.getTime() <= 5 * 60_000
        ? 'fresh'
        : 'stale';
    return {
      id: repository.id,
      project: repository.project
        ? {
            id: repository.project.id,
            name: repository.project.name,
            alias: repository.project.alias,
            jiraProjectKey: repository.project.jiraProjectKey,
          }
        : null,
      canonicalPath: repository.canonicalPath,
      displayName: repository.displayName,
      alias: repository.alias,
      gitDirKind: repository.gitDirKind,
      remoteName: repository.remoteName,
      remoteUrl: repository.remoteUrl,
      remoteHost: repository.remoteHost,
      remotePort: repository.remotePort,
      remotePath: repository.remotePath,
      gitlabConnectionId: repository.gitlabConnectionId,
      gitlabProjectRef: repository.gitlabProjectRef,
      baselineBranch: repository.baselineBranch,
      whitelistStatus: repository.whitelistStatus,
      statusReason: repository.statusReason,
      lastSeenAt: repository.lastSeenAt?.toISOString?.() ?? null,
      lastLocalRefreshAt: repository.lastLocalRefreshAt?.toISOString?.() ?? null,
      freshness,
      version: repository.version,
      latestSnapshot: latest
        ? {
            id: latest.id,
            headSha: latest.headSha,
            branchName: latest.branchName,
            detached: latest.detached,
            unborn: latest.unborn,
            upstreamRef: latest.upstreamRef,
            aheadCount: latest.aheadCount,
            behindCount: latest.behindCount,
            stagedCount: latest.stagedCount,
            unstagedCount: latest.unstagedCount,
            untrackedCount: latest.untrackedCount,
            conflictedCount: latest.conflictedCount,
            pathSummary: JSON.parse(latest.pathSummaryJson ?? '[]') as unknown,
            stashCount: latest.stashCount,
            recentCommit: JSON.parse(latest.recentCommitJson ?? '{}') as unknown,
            remotes: JSON.parse(latest.remotesJson ?? '[]') as unknown,
            status: latest.status,
            errorCode: latest.errorCode,
            collectedAt: latest.collectedAt.toISOString(),
          }
        : null,
    };
  }

  private async attachGitLab(
    repositories: Array<ReturnType<RepositoryService['toRepositoryView']>>,
  ) {
    const projects = await this.prisma.gitLabProject.findMany({
      where: { stale: false },
      include: {
        connection: true,
        mergeRequests: {
          where: { state: 'opened' },
          select: {
            iid: true,
            title: true,
            sourceBranch: true,
            targetBranch: true,
            webUrl: true,
          },
        },
        pipelines: { orderBy: { updatedExternalAt: 'desc' }, take: 1 },
        commits: { orderBy: { committedAt: 'desc' }, take: 1 },
      },
    });
    const summarize = (
      project: (typeof projects)[number],
      repository: (typeof repositories)[number],
    ) => ({
      id: project.id,
      externalId: project.externalId,
      connectionId: project.connectionId,
      pathWithNamespace: project.pathWithNamespace,
      name: project.name,
      webUrl: project.webUrl,
      defaultBranch: project.defaultBranch,
      openMergeRequestCount: project.mergeRequests.length,
      currentBranchMergeRequests: project.mergeRequests
        .filter(
          (mergeRequest) => mergeRequest.sourceBranch === repository.latestSnapshot?.branchName,
        )
        .map((mergeRequest) => ({
          iid: mergeRequest.iid,
          title: mergeRequest.title,
          sourceBranch: mergeRequest.sourceBranch,
          targetBranch: mergeRequest.targetBranch,
          webUrl: mergeRequest.webUrl,
        })),
      latestCommit: project.commits[0]
        ? {
            sha: project.commits[0].sha,
            title: project.commits[0].title,
            authorName: project.commits[0].authorName,
            committedAt: project.commits[0].committedAt.toISOString(),
            webUrl: project.commits[0].webUrl,
          }
        : null,
      latestPipeline: project.pipelines[0]
        ? {
            status: project.pipelines[0].status,
            sha: project.pipelines[0].sha,
            ref: project.pipelines[0].ref,
            updatedAt: project.pipelines[0].updatedExternalAt?.toISOString() ?? null,
            webUrl: project.pipelines[0].webUrl,
          }
        : null,
      syncStatus: deriveGitLabFreshness(project.syncStatus, project.syncedAt),
      syncError: project.syncError,
      syncedAt: project.syncedAt?.toISOString() ?? null,
    });
    return repositories.map((repository) => {
      const candidates = projects.filter((project) => {
        if (!project.connection.baseUrl || !repository.remoteHost || !repository.remotePath)
          return false;
        const connectionUrl = new URL(project.connection.baseUrl);
        return (
          connectionUrl.hostname.toLowerCase() === repository.remoteHost.toLowerCase() &&
          this.normalizedUrlPort(connectionUrl) === repository.remotePort &&
          project.pathWithNamespace === repository.remotePath
        );
      });
      const selected = candidates.find(
        (project) =>
          project.connectionId === repository.gitlabConnectionId &&
          project.externalId === repository.gitlabProjectRef,
      );
      const selectedProjectStillExists = projects.some(
        (project) =>
          project.connectionId === repository.gitlabConnectionId &&
          project.externalId === repository.gitlabProjectRef,
      );
      return {
        ...repository,
        gitlabMatchStatus: selected
          ? 'matched'
          : repository.gitlabProjectRef && selectedProjectStillExists
            ? 'mismatch'
            : candidates.length > 0
              ? 'candidate'
              : 'unavailable',
        gitlabCandidates: candidates.map((project) => summarize(project, repository)),
        gitlabSummary: selected ? summarize(selected, repository) : null,
      };
    });
  }

  private async attachTaskSummaries<
    T extends {
      project: { id: string; jiraProjectKey: string | null } | null;
    },
  >(repositories: T[]) {
    const projectIds = [
      ...new Set(
        repositories
          .map((repository) => repository.project?.id)
          .filter((projectId): projectId is string => Boolean(projectId)),
      ),
    ];
    if (projectIds.length === 0) {
      return repositories.map((repository) => ({
        ...repository,
        taskSummary: this.emptyTaskSummary('unmapped'),
      }));
    }

    // 状态、可见性、最近观测和逾期都按项目批量聚合，仓库列表不会随项目数产生 N+1 查询。
    const [statusGroups, overdueGroups] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['projectId', 'normalizedStatus', 'visibilityState'],
        where: { projectId: { in: projectIds } },
        _count: { _all: true },
        _max: { lastObservedAt: true },
      }),
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: {
          projectId: { in: projectIds },
          visibilityState: 'visible',
          normalizedStatus: { notIn: ['done', 'cancelled'] },
          dueDate: { lt: this.shanghaiBusinessDate() },
        },
        _count: { _all: true },
      }),
    ]);
    const overdueByProject = new Map(
      overdueGroups.map((group) => [group.projectId, group._count._all]),
    );

    return repositories.map((repository) => {
      if (!repository.project) {
        return { ...repository, taskSummary: this.emptyTaskSummary('unmapped') };
      }
      if (!repository.project.jiraProjectKey) {
        return { ...repository, taskSummary: this.emptyTaskSummary('not_configured') };
      }
      const groups = statusGroups.filter((group) => group.projectId === repository.project?.id);
      const counts = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<
        (typeof taskStatuses)[number],
        number
      >;
      let visibleCount = 0;
      let notVisibleCount = 0;
      let latestObservedAt: Date | null = null;
      for (const group of groups) {
        if (group.visibilityState === 'visible') {
          visibleCount += group._count._all;
          if (taskStatuses.includes(group.normalizedStatus as (typeof taskStatuses)[number])) {
            counts[group.normalizedStatus as (typeof taskStatuses)[number]] += group._count._all;
          }
        } else {
          notVisibleCount += group._count._all;
        }
        const observedAt = group._max.lastObservedAt;
        if (observedAt && (!latestObservedAt || observedAt > latestObservedAt)) {
          latestObservedAt = observedAt;
        }
      }
      const freshness =
        groups.length === 0
          ? 'empty'
          : latestObservedAt && Date.now() - latestObservedAt.getTime() <= 15 * 60_000
            ? 'fresh'
            : 'stale';
      return {
        ...repository,
        taskSummary: {
          sourceStatus: freshness,
          visibleCount,
          notVisibleCount,
          counts,
          overdueCount: overdueByProject.get(repository.project.id) ?? 0,
          lastObservedAt: latestObservedAt?.toISOString() ?? null,
        },
      };
    });
  }

  private emptyTaskSummary(sourceStatus: 'unmapped' | 'not_configured') {
    return {
      sourceStatus,
      visibleCount: 0,
      notVisibleCount: 0,
      counts: Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<
        (typeof taskStatuses)[number],
        number
      >,
      overdueCount: 0,
      lastObservedAt: null,
    };
  }

  private shanghaiBusinessDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private normalizedUrlPort(url: URL): number | null {
    return url.port ? Number(url.port) : null;
  }
}
