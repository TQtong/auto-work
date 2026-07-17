import { Injectable } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId } from '@auto-work/domain';
import type { GitSnapshot, Prisma, Project, Repository } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RepositoryInspectorService } from './repository-inspector.service.js';
import type { DiscoveryWarning, RepositoryIdentity } from './repository.types.js';

type RepositoryViewSource = Repository & {
  project?: Project | null;
  snapshots?: GitSnapshot[];
};

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
        const snapshot = await this.collectAndPersistSnapshot(
          repository.id,
          identity.canonicalPath,
        );
        repositories.push(this.toRepositoryView({ ...repository, snapshots: [snapshot] }));
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
    return repositories.map((repository) => this.toRepositoryView(repository));
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
    return this.toRepositoryView(repository);
  }

  public async confirm(
    id: string,
    input: {
      displayName: string;
      alias?: string | null | undefined;
      projectId?: string | null | undefined;
      remoteName?: string | null | undefined;
      baselineBranch: string;
      discoverySnapshotVersion: number;
    },
  ) {
    const repository = await this.prisma.repository.findUnique({ where: { id } });
    if (!repository) throw new DomainError(errorCodes.notFound, '仓库不存在', { httpStatus: 404 });
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
        remotePath: selectedRemote?.path ?? null,
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
  }) {
    const data: Prisma.ProjectCreateInput = { id: newId(), name: input.name };
    if (input.alias !== undefined) data.alias = input.alias;
    if (input.description !== undefined) data.description = input.description;
    return this.prisma.project.create({
      data,
    });
  }

  public async listProjects(includeArchived: boolean) {
    const rows = await this.prisma.project.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: { _count: { select: { repositories: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      alias: row.alias,
      description: row.description,
      enabled: row.enabled,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      repositoryCount: row._count.repositories,
      version: row.version,
    }));
  }

  private async upsertObservation(identity: RepositoryIdentity) {
    const existing = await this.prisma.repository.findUnique({
      where: { canonicalPath: identity.canonicalPath },
    });
    const remote = identity.defaultRemote;
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
          remotePath: remote?.path ?? null,
          baselineBranch: identity.branchName,
          whitelistStatus: 'discovered',
          lastSeenAt: new Date(),
        },
      });
    }
    const identityChanged = existing.identityHash !== identity.identityHash;
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
        remotePath: remote?.path ?? null,
        lastSeenAt: new Date(),
        whitelistStatus: identityChanged ? 'needs_review' : existing.whitelistStatus,
        statusReason: identityChanged ? '相同路径中的 Git 元数据身份已变化' : null,
        ...(identityChanged ? { version: { increment: 1 } } : {}),
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
          }
        : null,
      canonicalPath: repository.canonicalPath,
      displayName: repository.displayName,
      alias: repository.alias,
      gitDirKind: repository.gitDirKind,
      remoteName: repository.remoteName,
      remoteUrl: repository.remoteUrl,
      remoteHost: repository.remoteHost,
      remotePath: repository.remotePath,
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
}
