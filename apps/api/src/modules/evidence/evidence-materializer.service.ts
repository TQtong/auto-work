import { Injectable } from '@nestjs/common';
import type { Evidence, EvidenceLink, Prisma } from '@prisma/client';
import {
  evidenceRuleVersion,
  newId,
  requestHash,
  suggestEvidenceLinks,
  type EvidenceMatchSource,
  type EvidenceSourceType,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

interface MaterializedEvidence {
  sourceType: EvidenceSourceType;
  sourceInternalId: string;
  sourceExternalKey: string;
  gitlabProjectId: string;
  projectId: string | null;
  eventAt: Date | null;
  title: string;
  url: string | null;
  availabilityState: 'available' | 'stale' | 'unavailable';
  metadata: Record<string, unknown>;
  sourceSyncedAt: Date | null;
}

export interface EvidenceRefreshSummary {
  materialized: number;
  created: number;
  updated: number;
  unchanged: number;
  suggested: number;
  resuggested: number;
  suppressed: number;
  expired: number;
  needsRevalidation: number;
}

@Injectable()
export class EvidenceMaterializerService {
  public constructor(private readonly prisma: PrismaService) {}

  /** GitLab 缓存与证据建议在一个本地事务内收敛，失败时不会留下半套关联。 */
  public async refreshConnection(connectionId: string): Promise<EvidenceRefreshSummary> {
    return this.prisma.$transaction(
      async (tx) => {
        const summary: EvidenceRefreshSummary = {
          materialized: 0,
          created: 0,
          updated: 0,
          unchanged: 0,
          suggested: 0,
          resuggested: 0,
          suppressed: 0,
          expired: 0,
          needsRevalidation: 0,
        };
        const sources = await this.collectGitLabSources(tx, connectionId);
        const evidenceRows: Evidence[] = [];
        for (const source of sources) {
          const result = await this.upsertEvidence(tx, source, summary);
          evidenceRows.push(result);
        }
        summary.materialized = evidenceRows.length;
        await this.refreshSuggestions(tx, evidenceRows, summary);
        return summary;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  private async collectGitLabSources(
    tx: Prisma.TransactionClient,
    connectionId: string,
  ): Promise<MaterializedEvidence[]> {
    const projects = await tx.gitLabProject.findMany({
      where: { connectionId },
      orderBy: { id: 'asc' },
    });
    if (projects.length === 0) return [];
    const projectIds = projects.map((project) => project.id);
    const repositories = await tx.repository.findMany({
      where: {
        gitlabConnectionId: connectionId,
        gitlabProjectRef: { in: projects.map((project) => project.externalId) },
        projectId: { not: null },
      },
      select: { gitlabProjectRef: true, projectId: true },
    });
    const localProjectIds = new Map<string, Set<string>>();
    for (const repository of repositories) {
      if (!repository.gitlabProjectRef || !repository.projectId) continue;
      const ids = localProjectIds.get(repository.gitlabProjectRef) ?? new Set<string>();
      ids.add(repository.projectId);
      localProjectIds.set(repository.gitlabProjectRef, ids);
    }
    const [branches, commits, mergeRequests, pipelines, tags, releases] = await Promise.all([
      tx.gitLabBranch.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
      tx.gitLabCommit.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
      tx.gitLabMergeRequest.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
      tx.gitLabPipeline.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
      tx.gitLabTag.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
      tx.gitLabRelease.findMany({ where: { gitlabProjectId: { in: projectIds } } }),
    ]);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const resolveProject = (gitlabProjectId: string) => {
      const project = projectById.get(gitlabProjectId);
      if (!project) throw new Error(`GitLab 项目缓存不存在: ${gitlabProjectId}`);
      const ids = localProjectIds.get(project.externalId);
      return {
        project,
        // 多个本地项目指向同一 GitLab 项目时不武断选一个，关键词规则因此自动停用。
        localProjectId: ids?.size === 1 ? ([...ids][0] ?? null) : null,
      };
    };
    const result: MaterializedEvidence[] = [];
    for (const branch of branches) {
      const { project, localProjectId } = resolveProject(branch.gitlabProjectId);
      result.push({
        sourceType: 'branch',
        sourceInternalId: branch.id,
        sourceExternalKey: `${project.pathWithNamespace}:${branch.name}`,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: branch.syncedAt,
        title: branch.name,
        url: branch.webUrl,
        availabilityState: project.stale ? 'stale' : branch.stale ? 'unavailable' : 'available',
        metadata: {
          name: branch.name,
          sha: branch.sha,
          protected: branch.protected,
          defaultBranch: branch.defaultBranch,
          merged: branch.merged,
        },
        sourceSyncedAt: branch.syncedAt,
      });
    }
    for (const commit of commits) {
      const { project, localProjectId } = resolveProject(commit.gitlabProjectId);
      result.push({
        sourceType: 'commit',
        sourceInternalId: commit.id,
        sourceExternalKey: commit.sha,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: commit.committedAt,
        title: commit.title,
        url: commit.webUrl,
        availabilityState: project.stale ? 'stale' : 'available',
        metadata: {
          sha: commit.sha,
          shortSha: commit.shortSha,
          messageSummary: commit.messageSummary,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          committerName: commit.committerName,
          committerEmail: commit.committerEmail,
        },
        sourceSyncedAt: commit.syncedAt,
      });
    }
    for (const mergeRequest of mergeRequests) {
      const { project, localProjectId } = resolveProject(mergeRequest.gitlabProjectId);
      result.push({
        sourceType: 'merge_request',
        sourceInternalId: mergeRequest.id,
        sourceExternalKey: `${project.pathWithNamespace}!${mergeRequest.iid}`,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: mergeRequest.mergedAt ?? mergeRequest.closedAt ?? mergeRequest.updatedExternalAt,
        title: mergeRequest.title,
        url: mergeRequest.webUrl,
        availabilityState: project.stale ? 'stale' : 'available',
        metadata: {
          iid: mergeRequest.iid,
          state: mergeRequest.state,
          sourceBranch: mergeRequest.sourceBranch,
          targetBranch: mergeRequest.targetBranch,
          draft: mergeRequest.draft,
          author: this.parseJson(mergeRequest.authorJson),
          assignees: this.parseJson(mergeRequest.assigneesJson),
        },
        sourceSyncedAt: mergeRequest.syncedAt,
      });
    }
    for (const pipeline of pipelines) {
      const { project, localProjectId } = resolveProject(pipeline.gitlabProjectId);
      result.push({
        sourceType: 'pipeline',
        sourceInternalId: pipeline.id,
        sourceExternalKey: `${project.pathWithNamespace}#${pipeline.externalId}`,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: pipeline.updatedExternalAt ?? pipeline.createdExternalAt,
        title: `Pipeline #${pipeline.iid ?? pipeline.externalId} · ${pipeline.ref ?? pipeline.sha.slice(0, 12)}`,
        url: pipeline.webUrl,
        availabilityState: project.stale ? 'stale' : 'available',
        metadata: {
          externalId: pipeline.externalId,
          iid: pipeline.iid,
          sha: pipeline.sha,
          ref: pipeline.ref,
          status: pipeline.status,
          source: pipeline.source,
        },
        sourceSyncedAt: pipeline.syncedAt,
      });
    }
    for (const tag of tags) {
      const { project, localProjectId } = resolveProject(tag.gitlabProjectId);
      result.push({
        sourceType: 'tag',
        sourceInternalId: tag.id,
        sourceExternalKey: `${project.pathWithNamespace}:${tag.name}`,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: tag.createdExternalAt,
        title: tag.name,
        url: tag.webUrl,
        availabilityState: project.stale ? 'stale' : tag.stale ? 'unavailable' : 'available',
        metadata: {
          name: tag.name,
          sha: tag.targetSha,
          messageSummary: tag.messageSummary,
          protected: tag.protected,
        },
        sourceSyncedAt: tag.syncedAt,
      });
    }
    for (const release of releases) {
      const { project, localProjectId } = resolveProject(release.gitlabProjectId);
      result.push({
        sourceType: 'release',
        sourceInternalId: release.id,
        sourceExternalKey: `${project.pathWithNamespace}:${release.tagName}`,
        gitlabProjectId: project.id,
        projectId: localProjectId,
        eventAt: release.releasedAt ?? release.createdExternalAt,
        title: release.name ?? release.tagName,
        url: release.webUrl,
        availabilityState: project.stale ? 'stale' : release.stale ? 'unavailable' : 'available',
        metadata: {
          tagName: release.tagName,
          name: release.name,
          descriptionSummary: release.descriptionSummary,
          upcomingRelease: release.upcomingRelease,
          assets: this.parseJson(release.assetsJson),
        },
        sourceSyncedAt: release.syncedAt,
      });
    }
    return result.sort(
      (left, right) =>
        left.sourceType.localeCompare(right.sourceType) ||
        left.sourceInternalId.localeCompare(right.sourceInternalId),
    );
  }

  private async upsertEvidence(
    tx: Prisma.TransactionClient,
    source: MaterializedEvidence,
    summary: EvidenceRefreshSummary,
  ): Promise<Evidence> {
    const contentHash = requestHash({
      sourceType: source.sourceType,
      sourceExternalKey: source.sourceExternalKey,
      projectId: source.projectId,
      eventAt: source.eventAt?.toISOString() ?? null,
      title: source.title,
      url: source.url,
      metadata: source.metadata,
    });
    const existing = await tx.evidence.findUnique({
      where: {
        sourceType_sourceInternalId: {
          sourceType: source.sourceType,
          sourceInternalId: source.sourceInternalId,
        },
      },
    });
    if (!existing) {
      summary.created += 1;
      return tx.evidence.create({
        data: {
          id: newId(),
          sourceType: source.sourceType,
          sourceInternalId: source.sourceInternalId,
          sourceExternalKey: source.sourceExternalKey,
          gitlabProjectId: source.gitlabProjectId,
          projectId: source.projectId,
          eventAt: source.eventAt,
          title: source.title,
          url: source.url,
          contentHash,
          availabilityState: source.availabilityState,
          metadataJson: JSON.stringify(source.metadata),
          sourceSyncedAt: source.sourceSyncedAt,
        },
      });
    }
    const contentChanged = existing.contentHash !== contentHash;
    const availabilityChanged = existing.availabilityState !== source.availabilityState;
    if (!contentChanged && !availabilityChanged && existing.projectId === source.projectId) {
      summary.unchanged += 1;
      if (existing.sourceSyncedAt?.getTime() === source.sourceSyncedAt?.getTime()) return existing;
      // 同步时间只表示新鲜度，不属于来源业务内容，更新它不会让已确认关系误进入复核。
      return tx.evidence.update({
        where: { id: existing.id },
        data: { sourceSyncedAt: source.sourceSyncedAt },
      });
    }
    summary.updated += 1;
    const updated = await tx.evidence.update({
      where: { id: existing.id },
      data: {
        sourceExternalKey: source.sourceExternalKey,
        gitlabProjectId: source.gitlabProjectId,
        projectId: source.projectId,
        eventAt: source.eventAt,
        title: source.title,
        url: source.url,
        contentHash,
        availabilityState: source.availabilityState,
        metadataJson: JSON.stringify(source.metadata),
        sourceSyncedAt: source.sourceSyncedAt,
        version: { increment: 1 },
      },
    });
    const links = await tx.evidenceLink.findMany({ where: { evidenceId: existing.id } });
    for (const link of links) {
      const needsRevalidation = link.status === 'confirmed' && link.revalidationState === 'valid';
      if (needsRevalidation) {
        await tx.evidenceLink.update({
          where: { id: link.id },
          data: { revalidationState: 'needs_revalidation', version: { increment: 1 } },
        });
        summary.needsRevalidation += 1;
      }
      await this.appendEvent(
        tx,
        link,
        source.availabilityState === 'available' ? 'source_changed' : 'source_unavailable',
        link.status,
        contentChanged ? '来源内容哈希发生变化' : '来源可用性发生变化',
        contentHash,
      );
    }
    return updated;
  }

  private async refreshSuggestions(
    tx: Prisma.TransactionClient,
    evidenceRows: Evidence[],
    summary: EvidenceRefreshSummary,
  ): Promise<void> {
    const availableEvidence = evidenceRows.filter(
      (evidence) => evidence.availabilityState === 'available',
    );
    const [tasks, projects, confirmedCommitLinks] = await Promise.all([
      tx.task.findMany({
        where: { visibilityState: 'visible' },
        select: {
          id: true,
          issueKey: true,
          projectId: true,
          title: true,
          parentTitle: true,
          externalUpdatedAt: true,
          lastObservedAt: true,
        },
      }),
      tx.project.findMany({
        where: { jiraProjectKey: { not: null }, enabled: true, archivedAt: null },
        select: { jiraProjectKey: true },
      }),
      tx.evidenceLink.findMany({
        where: { status: 'confirmed', evidence: { sourceType: 'commit' } },
        include: { evidence: true },
      }),
    ]);
    const suggestions = suggestEvidenceLinks({
      tasks: tasks.map((task) => ({
        id: task.id,
        issueKey: task.issueKey,
        projectId: task.projectId,
        title: task.title,
        parentTitle: task.parentTitle,
        anchorAt: task.externalUpdatedAt ?? task.lastObservedAt,
      })),
      evidence: availableEvidence.map((evidence) => this.matchSource(evidence)),
      knownProjectKeys: projects.flatMap((project) =>
        project.jiraProjectKey ? [project.jiraProjectKey] : [],
      ),
      confirmedCommitRelations: confirmedCommitLinks.flatMap((link) => {
        const metadata = this.parseJson(link.evidence.metadataJson);
        return typeof metadata.sha === 'string'
          ? [
              {
                taskId: link.targetId,
                sha: metadata.sha,
                gitlabProjectId: link.evidence.gitlabProjectId,
              },
            ]
          : [];
      }),
    });
    const activePairs = new Set(suggestions.map((item) => `${item.taskId}:${item.evidenceId}`));
    for (const suggestion of suggestions) {
      const evidence = availableEvidence.find((item) => item.id === suggestion.evidenceId);
      if (!evidence) continue;
      const existing = await tx.evidenceLink.findUnique({
        where: {
          targetType_targetId_evidenceId: {
            targetType: 'task',
            targetId: suggestion.taskId,
            evidenceId: suggestion.evidenceId,
          },
        },
      });
      if (!existing) {
        const link = await tx.evidenceLink.create({
          data: {
            id: newId(),
            targetType: 'task',
            targetId: suggestion.taskId,
            taskId: suggestion.taskId,
            evidenceId: suggestion.evidenceId,
            method: suggestion.method,
            confidence: suggestion.confidence,
            status: 'suggested',
            explanation: suggestion.explanation,
            matchedValue: suggestion.matchedValue,
            ruleVersion: suggestion.ruleVersion,
            sourceContentHash: evidence.contentHash,
          },
        });
        await this.appendEvent(
          tx,
          link,
          'suggested',
          'suggested',
          '规则首次产生证据建议',
          evidence.contentHash,
        );
        summary.suggested += 1;
        continue;
      }
      const basisChanged =
        existing.sourceContentHash !== evidence.contentHash ||
        existing.ruleVersion !== suggestion.ruleVersion;
      if (existing.status === 'rejected' && !basisChanged) {
        summary.suppressed += 1;
        continue;
      }
      if (['rejected', 'expired'].includes(existing.status) && basisChanged) {
        const updated = await tx.evidenceLink.update({
          where: { id: existing.id },
          data: {
            method: suggestion.method,
            confidence: suggestion.confidence,
            status: 'suggested',
            explanation: suggestion.explanation,
            matchedValue: suggestion.matchedValue,
            ruleVersion: suggestion.ruleVersion,
            sourceContentHash: evidence.contentHash,
            decisionReason: null,
            rejectedBy: null,
            rejectedAt: null,
            expiredAt: null,
            revalidationState: 'valid',
            version: { increment: 1 },
          },
        });
        await this.appendEvent(
          tx,
          updated,
          'resuggested',
          'suggested',
          '来源内容或规则版本变化，解除旧拒绝/失效抑制',
          evidence.contentHash,
          existing.status,
        );
        summary.resuggested += 1;
        continue;
      }
      if (existing.status === 'confirmed') {
        if (basisChanged && existing.revalidationState === 'valid') {
          const updated = await tx.evidenceLink.update({
            where: { id: existing.id },
            data: { revalidationState: 'needs_revalidation', version: { increment: 1 } },
          });
          await this.appendEvent(
            tx,
            updated,
            'rule_changed',
            'confirmed',
            '确认依据的规则版本或来源内容已变化',
            evidence.contentHash,
          );
          summary.needsRevalidation += 1;
        }
        continue;
      }
      await tx.evidenceLink.update({
        where: { id: existing.id },
        data: {
          method: suggestion.method,
          confidence: suggestion.confidence,
          explanation: suggestion.explanation,
          matchedValue: suggestion.matchedValue,
          ruleVersion: suggestion.ruleVersion,
          sourceContentHash: evidence.contentHash,
          ...(basisChanged ? { version: { increment: 1 } } : {}),
        },
      });
    }

    const automaticLinks = await tx.evidenceLink.findMany({
      where: {
        evidenceId: { in: evidenceRows.map((item) => item.id) },
        status: 'suggested',
        method: { notIn: ['manual', 'ai'] },
      },
      include: { evidence: true },
    });
    for (const link of automaticLinks) {
      if (activePairs.has(`${link.targetId}:${link.evidenceId}`)) continue;
      const updated = await tx.evidenceLink.update({
        where: { id: link.id },
        data: {
          status: 'expired',
          expiredAt: new Date(),
          decisionReason:
            link.evidence.availabilityState === 'available'
              ? '当前规则不再产生该建议'
              : '证据来源当前不可用',
          version: { increment: 1 },
        },
      });
      await this.appendEvent(
        tx,
        updated,
        'expired',
        'expired',
        updated.decisionReason,
        link.evidence.contentHash,
        'suggested',
      );
      summary.expired += 1;
    }
  }

  private matchSource(evidence: Evidence): EvidenceMatchSource {
    const metadata = this.parseJson(evidence.metadataJson);
    return {
      id: evidence.id,
      sourceType: evidence.sourceType as EvidenceSourceType,
      gitlabProjectId: evidence.gitlabProjectId,
      projectId: evidence.projectId,
      eventAt: evidence.eventAt,
      title: evidence.title,
      contentHash: evidence.contentHash,
      metadata: {
        messageSummary:
          typeof metadata.messageSummary === 'string' ? metadata.messageSummary : null,
        sourceBranch: typeof metadata.sourceBranch === 'string' ? metadata.sourceBranch : null,
        ref: typeof metadata.ref === 'string' ? metadata.ref : null,
        sha: typeof metadata.sha === 'string' ? metadata.sha : null,
      },
    };
  }

  private async appendEvent(
    tx: Prisma.TransactionClient,
    link: Pick<EvidenceLink, 'id' | 'status' | 'ruleVersion' | 'sourceContentHash'>,
    action: string,
    toStatus: string,
    reason: string | null,
    sourceContentHash: string,
    fromStatus?: string | null,
  ): Promise<void> {
    const last = await tx.evidenceLinkEvent.aggregate({
      where: { evidenceLinkId: link.id },
      _max: { sequence: true },
    });
    await tx.evidenceLinkEvent.create({
      data: {
        id: newId(),
        evidenceLinkId: link.id,
        sequence: (last._max.sequence ?? 0) + 1,
        action,
        fromStatus: fromStatus ?? null,
        toStatus,
        actorType: 'system',
        actorId: 'evidence-materializer',
        reason,
        sourceContentHash,
        ruleVersion: link.ruleVersion || evidenceRuleVersion,
      },
    });
  }

  private parseJson(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
