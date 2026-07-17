import { Injectable } from '@nestjs/common';
import type { FieldMappingVersion, IntegrationConnection, JiraSyncRun, Task } from '@prisma/client';
import { DomainError, type NormalizedTaskStatus } from '@auto-work/contracts';
import { buildJiraQuery, newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { JiraApiClient, type JiraCredential } from './jira-api.client.js';
import {
  normalizeJiraIssue,
  type JiraFieldMappings,
  type NormalizedJiraTask,
} from './jira-task-normalizer.js';

const MAX_PAGES = 500;

interface JiraSyncRequest {
  scope: 'default' | 'weekly' | 'quarterly' | 'incremental' | 'full';
  periodStart?: string;
  periodEnd?: string;
}

interface SyncCounts {
  pages: number;
  read: number;
  created: number;
  updated: number;
  unchanged: number;
}

@Injectable()
export class JiraSyncService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly client: JiraApiClient,
  ) {}

  public async sync(input: {
    run: JiraSyncRun;
    connection: IntegrationConnection;
    token: string;
    reportProgress: (value: number) => Promise<void>;
  }) {
    const { run, connection } = input;
    if (!connection.enabled || !connection.baseUrl) {
      throw new DomainError('JIRA_CONNECTION_DISABLED', 'Jira 连接未启用或缺少基础地址', {
        httpStatus: 409,
      });
    }
    const request = JSON.parse(run.requestJson) as JiraSyncRequest;
    const mapping = await this.prisma.fieldMappingVersion.findFirst({
      where: { id: run.mappingVersionId, connectionId: connection.id },
    });
    if (!mapping) {
      throw new DomainError('JIRA_MAPPING_NOT_FOUND', '同步绑定的字段映射版本不存在', {
        httpStatus: 409,
      });
    }
    const config = JSON.parse(connection.configJson) as Record<string, unknown>;
    const capabilities = JSON.parse(connection.capabilitiesJson) as Record<string, unknown>;
    const credential: JiraCredential = {
      token: input.token,
      authScheme: config.authScheme === 'basic_pat' ? 'basic_pat' : 'bearer',
      ...(config.authScheme === 'basic_pat' && typeof config.accountName === 'string'
        ? { accountName: config.accountName }
        : {}),
    };
    const mappings = JSON.parse(mapping.fieldMappingsJson) as JiraFieldMappings;
    const statusMappings = JSON.parse(mapping.statusMappingsJson) as Record<
      string,
      NormalizedTaskStatus
    >;
    const parserRules = JSON.parse(mapping.parserRulesJson) as Record<string, unknown>;
    const identity = this.identity(capabilities);
    const cursorScope = `jira:${request.scope}`;
    const cursor = await this.prisma.syncCursor.upsert({
      where: { connectionId_scope: { connectionId: connection.id, scope: cursorScope } },
      create: { id: newId(), connectionId: connection.id, scope: cursorScope },
      update: {},
    });
    const updatedFloor = cursor.lastUpdatedAt
      ? new Date(cursor.lastUpdatedAt.getTime() - cursor.overlapSeconds * 1_000)
      : new Date(0);
    const jql = buildJiraQuery({
      scope: request.scope,
      ...(request.periodStart ? { periodStart: request.periodStart } : {}),
      ...(request.periodEnd ? { periodEnd: request.periodEnd } : {}),
      updatedFloor,
      plannedStartFieldId: mappings.plannedStartDate,
    });
    const fields = this.requestedFields(mappings, parserRules);
    const queryHash = requestHash({ jql, fields, mappingVersionId: mapping.id });
    const counts: SyncCounts = { pages: 0, read: 0, created: 0, updated: 0, unchanged: 0 };
    const seenIssueKeys = new Set<string>();
    let maxTuple: { updatedAt: Date; issueKey: string } | null = null;
    await this.prisma.jiraSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'running',
        queryHash,
        cursorBeforeJson: JSON.stringify({
          lastUpdatedAt: cursor.lastUpdatedAt?.toISOString() ?? null,
          lastTiebreaker: cursor.lastTiebreaker,
          overlapSeconds: cursor.overlapSeconds,
        }),
        startedAt: new Date(),
      },
    });

    try {
      const method = this.searchMethod(capabilities);
      const maxResults = this.pageSize(config);
      let startAt = 0;
      let paginationCompleted = false;
      const visitedStarts = new Set<number>();
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        if (visitedStarts.has(startAt)) {
          throw new DomainError('JIRA_PAGINATION_LOOP', 'Jira 分页起点形成循环', {
            httpStatus: 502,
          });
        }
        visitedStarts.add(startAt);
        const page = await this.client.searchPage({
          baseUrl: connection.baseUrl,
          credential,
          jql,
          fields,
          startAt,
          maxResults,
          method,
        });
        const actualStart = page.startAt ?? startAt;
        if (actualStart < startAt) {
          throw new DomainError('JIRA_PAGINATION_REGRESSED', 'Jira 分页起点倒退', {
            httpStatus: 502,
          });
        }
        if (page.issues.length === 0) {
          if (page.total !== undefined && actualStart < page.total) {
            throw new DomainError('JIRA_PAGINATION_EMPTY_PAGE', 'Jira 在总数结束前返回空页', {
              httpStatus: 502,
              retryable: true,
            });
          }
          paginationCompleted = true;
          break;
        }
        const normalized = page.issues.map((issue) =>
          normalizeJiraIssue({
            issue,
            mappings,
            statusMappings,
            currentIdentity: identity,
            parentFallbackFieldId:
              typeof parserRules.parentFallbackFieldId === 'string'
                ? parserRules.parentFallbackFieldId
                : null,
          }),
        );
        for (const task of normalized) {
          seenIssueKeys.add(task.issueKey);
          const outcome = await this.saveTask(connection.id, mapping, run.id, task);
          counts[outcome] += 1;
          if (
            !maxTuple ||
            task.externalUpdatedAt > maxTuple.updatedAt ||
            (task.externalUpdatedAt.getTime() === maxTuple.updatedAt.getTime() &&
              task.issueKey.localeCompare(maxTuple.issueKey) > 0)
          ) {
            maxTuple = { updatedAt: task.externalUpdatedAt, issueKey: task.issueKey };
          }
        }
        counts.pages += 1;
        counts.read += normalized.length;
        await input.reportProgress(
          page.total && page.total > 0
            ? Math.min(95, Math.round(((actualStart + normalized.length) / page.total) * 95))
            : Math.min(95, Math.round(((pageIndex + 1) / MAX_PAGES) * 95)),
        );
        const nextStart = actualStart + page.issues.length;
        if (page.total !== undefined && nextStart >= page.total) {
          paginationCompleted = true;
          break;
        }
        startAt = nextStart;
      }
      if (!paginationCompleted) {
        throw new DomainError('JIRA_PAGINATION_LIMIT', 'Jira 分页超过安全上限', {
          httpStatus: 502,
        });
      }
      await this.linkParents(connection.id);
      if (request.scope === 'full') {
        await this.prisma.task.updateMany({
          where: {
            connectionId: connection.id,
            primarySource: 'jira',
            issueKey: { notIn: [...seenIssueKeys] },
          },
          data: { visibilityState: 'out_of_scope', version: { increment: 1 } },
        });
      }
      const cursorAfter = maxTuple
        ? { lastUpdatedAt: maxTuple.updatedAt.toISOString(), lastTiebreaker: maxTuple.issueKey }
        : {
            lastUpdatedAt: cursor.lastUpdatedAt?.toISOString() ?? null,
            lastTiebreaker: cursor.lastTiebreaker,
          };
      await this.prisma.$transaction([
        this.prisma.syncCursor.update({
          where: { id: cursor.id },
          data: {
            ...(maxTuple
              ? { lastUpdatedAt: maxTuple.updatedAt, lastTiebreaker: maxTuple.issueKey }
              : {}),
            lastSuccessRunId: run.id,
            version: { increment: 1 },
          },
        }),
        this.prisma.jiraSyncRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            pageCount: counts.pages,
            readCount: counts.read,
            createdCount: counts.created,
            updatedCount: counts.updated,
            unchangedCount: counts.unchanged,
            cursorAfterJson: JSON.stringify(cursorAfter),
            completedAt: new Date(),
          },
        }),
        this.prisma.integrationConnection.update({
          where: { id: connection.id },
          data: { status: 'healthy', lastSuccessAt: new Date(), version: { increment: 1 } },
        }),
      ]);
      await input.reportProgress(100);
      return { runId: run.id, counts, cursor: cursorAfter };
    } catch (error) {
      const domainError = error instanceof DomainError ? error : null;
      await this.prisma.$transaction([
        this.prisma.jiraSyncRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            pageCount: counts.pages,
            readCount: counts.read,
            createdCount: counts.created,
            updatedCount: counts.updated,
            unchangedCount: counts.unchanged,
            errorCount: 1,
            errorCode: domainError?.code ?? 'JIRA_SYNC_FAILED',
            errorSummary: (error instanceof Error ? error.message : 'Jira 同步失败').slice(
              0,
              1_000,
            ),
            completedAt: new Date(),
          },
        }),
        this.prisma.integrationConnection.update({
          where: { id: connection.id },
          data: {
            status:
              domainError?.code === 'JIRA_MAPPING_INVALID'
                ? 'mapping_invalid'
                : ['JIRA_CREDENTIAL_INVALID', 'JIRA_PERMISSION_DENIED'].includes(
                      domainError?.code ?? '',
                    )
                  ? 'invalid'
                  : 'degraded',
            version: { increment: 1 },
          },
        }),
      ]);
      throw error;
    }
  }

  private async saveTask(
    connectionId: string,
    mapping: FieldMappingVersion,
    runId: string,
    value: NormalizedJiraTask,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const existing = await this.prisma.task.findUnique({
      where: { connectionId_issueKey: { connectionId, issueKey: value.issueKey } },
      include: { sourceObservations: { orderBy: { observedAt: 'desc' }, take: 1 } },
    });
    const project = await this.prisma.project.findUnique({
      where: { jiraProjectKey: value.projectKey },
      select: { id: true },
    });
    const observedAt = new Date();
    const data = {
      projectId: project?.id ?? null,
      primarySource: 'jira',
      externalId: value.externalId,
      issueKey: value.issueKey,
      projectKey: value.projectKey,
      issueType: value.issueType,
      parentIssueKey: value.parentIssueKey,
      parentTitle: value.parentTitle,
      title: value.title.slice(0, 4_000),
      descriptionPolicy: 'not_persisted',
      priority: value.priority,
      assigneeExternalId: value.assigneeExternalId,
      assigneeName: value.assigneeName,
      isCurrentUser: value.isCurrentUser,
      rawStatusId: value.rawStatusId,
      rawStatusName: value.rawStatusName,
      normalizedStatus: value.normalizedStatus,
      plannedStartDate: value.plannedStartDate,
      dueDate: value.dueDate,
      originalEstimateSeconds: value.originalEstimateSeconds,
      remainingEstimateSeconds: value.remainingEstimateSeconds,
      timeSpentSeconds: value.timeSpentSeconds,
      sprintIdsJson: JSON.stringify(value.sprintIds),
      labelsJson: JSON.stringify(value.labels),
      componentsJson: JSON.stringify(value.components),
      externalUpdatedAt: value.externalUpdatedAt,
      lastObservedAt: observedAt,
      visibilityState: 'visible',
      mappingVersionId: mapping.id,
    };
    const unchanged = existing?.sourceObservations[0]?.contentHash === value.contentHash;
    const task: Task = existing
      ? await this.prisma.task.update({
          where: { id: existing.id },
          data: unchanged
            ? { lastObservedAt: observedAt, visibilityState: 'visible' }
            : { ...data, version: { increment: 1 } },
        })
      : await this.prisma.task.create({
          data: { id: newId(), connectionId, ...data },
        });
    const observation = await this.prisma.taskSourceObservation.findFirst({
      where: {
        taskId: task.id,
        sourceUpdatedAt: value.externalUpdatedAt,
        contentHash: value.contentHash,
      },
    });
    if (!observation) {
      const createdObservation = await this.prisma.taskSourceObservation.create({
        data: {
          id: newId(),
          taskId: task.id,
          sourceType: 'jira',
          sourceUpdatedAt: value.externalUpdatedAt,
          contentHash: value.contentHash,
          fieldsJson: JSON.stringify(value.observationFields),
          warningsJson: JSON.stringify(value.warnings),
          syncRunId: runId,
          mappingVersionId: mapping.id,
          observedAt,
        },
      });
      if (
        !existing ||
        existing.rawStatusId !== value.rawStatusId ||
        existing.rawStatusName !== value.rawStatusName ||
        existing.normalizedStatus !== value.normalizedStatus
      ) {
        await this.prisma.taskStatusEvent.create({
          data: {
            id: newId(),
            taskId: task.id,
            fromRawStatusId: existing?.rawStatusId ?? null,
            fromRawStatusName: existing?.rawStatusName ?? null,
            fromNormalizedStatus: existing?.normalizedStatus ?? null,
            toRawStatusId: value.rawStatusId,
            toRawStatusName: value.rawStatusName,
            toNormalizedStatus: value.normalizedStatus,
            // Search 未携带 changelog，只能声明从上次观测到本次观测的变化区间。
            effectiveAt: value.externalUpdatedAt,
            observedAt,
            observedIntervalStart: existing?.lastObservedAt ?? null,
            sourceObservationId: createdObservation.id,
          },
        });
      }
    }
    return existing ? (unchanged ? 'unchanged' : 'updated') : 'created';
  }

  private async linkParents(connectionId: string): Promise<void> {
    const tasks = await this.prisma.task.findMany({
      where: { connectionId, primarySource: 'jira', parentIssueKey: { not: null } },
      select: { id: true, parentIssueKey: true },
    });
    const parentKeys = [
      ...new Set(tasks.map((task) => task.parentIssueKey).filter(Boolean)),
    ] as string[];
    const parents = await this.prisma.task.findMany({
      where: { connectionId, issueKey: { in: parentKeys } },
      select: { id: true, issueKey: true },
    });
    const byKey = new Map(parents.map((parent) => [parent.issueKey, parent.id]));
    for (const task of tasks) {
      const parentTaskId = task.parentIssueKey ? byKey.get(task.parentIssueKey) : undefined;
      if (parentTaskId && parentTaskId !== task.id) {
        await this.prisma.task.update({ where: { id: task.id }, data: { parentTaskId } });
      }
    }
  }

  private requestedFields(mappings: JiraFieldMappings, parserRules: Record<string, unknown>) {
    return [
      'summary',
      'updated',
      'project',
      'issuetype',
      ...Object.values(mappings).filter((value): value is string => typeof value === 'string'),
      ...(typeof parserRules.parentFallbackFieldId === 'string'
        ? [parserRules.parentFallbackFieldId]
        : []),
    ].filter((value, index, all) => all.indexOf(value) === index);
  }

  private identity(capabilities: Record<string, unknown>) {
    const value =
      capabilities.identity && typeof capabilities.identity === 'object'
        ? (capabilities.identity as Record<string, unknown>)
        : {};
    return {
      id: typeof value.id === 'string' ? value.id : '',
      username: typeof value.username === 'string' ? value.username : null,
      name: typeof value.name === 'string' ? value.name : null,
    };
  }

  private searchMethod(capabilities: Record<string, unknown>): 'post' | 'get' {
    const search =
      capabilities.search && typeof capabilities.search === 'object'
        ? (capabilities.search as Record<string, unknown>)
        : {};
    return search.selectedMethod === 'get' ? 'get' : 'post';
  }

  private pageSize(config: Record<string, unknown>): number {
    const value = typeof config.maxResults === 'number' ? config.maxResults : 100;
    return Math.min(Math.max(Math.trunc(value), 1), 1_000);
  }
}
