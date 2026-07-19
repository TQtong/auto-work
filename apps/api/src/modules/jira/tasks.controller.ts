import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { apiResponse, DomainError, errorCodes, normalizedTaskStatuses } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const taskQuerySchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    projectKey: z.string().trim().min(1).max(100).optional(),
    status: z.enum(normalizedTaskStatuses).optional(),
    rawStatus: z.string().trim().min(1).max(200).optional(),
    source: z.enum(['jira', 'excel', 'manual']).optional(),
    parentIssueKey: z.string().trim().min(1).max(100).optional(),
    sprintId: z.string().trim().min(1).max(200).optional(),
    evidenceState: z
      .enum(['none', 'suggested', 'confirmed', 'rejected', 'expired', 'needs_revalidation'])
      .optional(),
    currentUser: z.enum(['true', 'false']).optional(),
    visibility: z.enum(['visible', 'out_of_scope', 'unavailable']).default('visible'),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

@Controller('tasks')
export class TasksController {
  public constructor(private readonly prisma: PrismaService) {}

  @Get()
  public async list(@Query() rawQuery: Record<string, unknown>, @Req() request: FastifyRequest) {
    const query = taskQuerySchema.parse(rawQuery);
    const offset = this.decodeCursor(query.cursor);
    const where: Prisma.TaskWhereInput = {
      visibilityState: query.visibility,
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.projectKey ? { projectKey: query.projectKey } : {}),
      ...(query.status ? { normalizedStatus: query.status } : {}),
      ...(query.rawStatus ? { rawStatusName: query.rawStatus } : {}),
      ...(query.source ? { primarySource: query.source } : {}),
      ...(query.parentIssueKey ? { parentIssueKey: query.parentIssueKey } : {}),
      // Sprint 以 JSON 字符串持久化；连同 JSON 引号匹配可避免筛选 "12" 时误命中 "112"。
      ...(query.sprintId ? { sprintIdsJson: { contains: JSON.stringify(query.sprintId) } } : {}),
      ...(query.currentUser ? { isCurrentUser: query.currentUser === 'true' } : {}),
      ...(query.evidenceState
        ? {
            evidenceLinks:
              query.evidenceState === 'none'
                ? { none: {} }
                : query.evidenceState === 'needs_revalidation'
                  ? { some: { revalidationState: 'needs_revalidation' } }
                  : { some: { status: query.evidenceState } },
          }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            dueDate: {
              ...(query.dateFrom ? { gte: query.dateFrom } : {}),
              ...(query.dateTo ? { lte: query.dateTo } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: [{ externalUpdatedAt: 'desc' }, { issueKey: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: query.limit,
        include: {
          project: { select: { id: true, name: true, jiraProjectKey: true } },
          evidenceLinks: { select: { status: true, revalidationState: true } },
          _count: {
            select: { sourceObservations: true, statusEvents: true, evidenceLinks: true },
          },
        },
      }),
      this.prisma.task.count({ where }),
    ]);
    const nextOffset = offset + items.length;
    return {
      ...apiResponse(
        items.map((item) => this.summary(item)),
        request.autoWork.correlationId,
        {
          asOf: new Date().toISOString(),
        },
      ),
      page: {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(nextOffset < total ? { nextCursor: this.encodeCursor(nextOffset) } : {}),
        hasMore: nextOffset < total,
        limit: query.limit,
      },
      total,
    };
  }

  @Get(':id')
  public async detail(@Param('id') id: string, @Req() request: FastifyRequest) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: true,
        mappingVersion: true,
        parentTask: { select: { id: true, issueKey: true, title: true } },
        childTasks: { select: { id: true, issueKey: true, title: true, normalizedStatus: true } },
        sourceObservations: { orderBy: { observedAt: 'desc' }, take: 50 },
        statusEvents: { orderBy: { observedAt: 'desc' }, take: 50 },
        fieldProvenances: {
          orderBy: [{ fieldName: 'asc' }, { effectiveAt: 'desc' }],
          take: 100,
        },
        evidenceLinks: { select: { status: true, revalidationState: true } },
      },
    });
    if (!task) throw new DomainError(errorCodes.notFound, '任务不存在', { httpStatus: 404 });
    return apiResponse(
      {
        ...this.summary(task),
        descriptionPolicy: task.descriptionPolicy,
        parentTask: task.parentTask,
        childTasks: task.childTasks,
        mappingVersion: task.mappingVersion
          ? { id: task.mappingVersion.id, versionNo: task.mappingVersion.versionNo }
          : null,
        observations: task.sourceObservations.map((observation) => ({
          id: observation.id,
          sourceType: observation.sourceType,
          sourceUpdatedAt: observation.sourceUpdatedAt?.toISOString() ?? null,
          fields: JSON.parse(observation.fieldsJson) as unknown,
          warnings: JSON.parse(observation.warningsJson) as unknown,
          contentHash: observation.contentHash,
          observedAt: observation.observedAt.toISOString(),
        })),
        fieldProvenances: task.fieldProvenances.map((provenance) => ({
          id: provenance.id,
          fieldName: provenance.fieldName,
          sourceType: provenance.sourceType,
          decision: provenance.decision,
          value: JSON.parse(provenance.valueJson) as unknown,
          reason: provenance.reason,
          active: provenance.active,
          effectiveAt: provenance.effectiveAt.toISOString(),
          supersededAt: provenance.supersededAt?.toISOString() ?? null,
          sourceObservationId: provenance.sourceObservationId,
          excelImportRowId: provenance.excelImportRowId,
        })),
        statusEvents: task.statusEvents.map((event) => ({
          id: event.id,
          from: {
            id: event.fromRawStatusId,
            name: event.fromRawStatusName,
            normalized: event.fromNormalizedStatus,
          },
          to: {
            id: event.toRawStatusId,
            name: event.toRawStatusName,
            normalized: event.toNormalizedStatus,
          },
          effectiveAt: event.effectiveAt?.toISOString() ?? null,
          observedAt: event.observedAt.toISOString(),
          observedIntervalStart: event.observedIntervalStart?.toISOString() ?? null,
          precision: 'observed_interval',
        })),
      },
      request.autoWork.correlationId,
    );
  }

  private summary(task: {
    id: string;
    primarySource: string;
    issueKey: string | null;
    projectKey: string | null;
    issueType: string | null;
    parentIssueKey: string | null;
    parentTitle: string | null;
    title: string;
    priority: string | null;
    assigneeName: string | null;
    isCurrentUser: boolean;
    rawStatusId: string | null;
    rawStatusName: string | null;
    normalizedStatus: string;
    plannedStartDate: string | null;
    dueDate: string | null;
    originalEstimateSeconds: number | null;
    remainingEstimateSeconds: number | null;
    timeSpentSeconds: number | null;
    sprintIdsJson: string;
    labelsJson: string;
    componentsJson: string;
    externalUpdatedAt: Date | null;
    lastObservedAt: Date;
    visibilityState: string;
    version: number;
    project?: { id: string; name: string; jiraProjectKey: string | null } | null;
    _count?: { sourceObservations: number; statusEvents: number; evidenceLinks: number };
    evidenceLinks?: Array<{ status: string; revalidationState: string }>;
  }) {
    return {
      id: task.id,
      source: task.primarySource,
      issueKey: task.issueKey,
      projectKey: task.projectKey,
      project: task.project ?? null,
      issueType: task.issueType,
      parent: { issueKey: task.parentIssueKey, title: task.parentTitle },
      title: task.title,
      priority: task.priority,
      assigneeName: task.assigneeName,
      isCurrentUser: task.isCurrentUser,
      status: {
        rawId: task.rawStatusId,
        rawName: task.rawStatusName,
        normalized: task.normalizedStatus,
      },
      schedule: { plannedStartDate: task.plannedStartDate, dueDate: task.dueDate },
      worklog: {
        originalEstimateSeconds: task.originalEstimateSeconds,
        remainingEstimateSeconds: task.remainingEstimateSeconds,
        timeSpentSeconds: task.timeSpentSeconds,
      },
      sprints: JSON.parse(task.sprintIdsJson) as unknown,
      labels: JSON.parse(task.labelsJson) as unknown,
      components: JSON.parse(task.componentsJson) as unknown,
      externalUpdatedAt: task.externalUpdatedAt?.toISOString() ?? null,
      lastObservedAt: task.lastObservedAt.toISOString(),
      visibilityState: task.visibilityState,
      counts: task._count ?? null,
      evidence: this.evidenceSummary(task.evidenceLinks ?? []),
      version: task.version,
    };
  }

  private evidenceSummary(links: Array<{ status: string; revalidationState: string }>) {
    const counts = { suggested: 0, confirmed: 0, rejected: 0, expired: 0 };
    for (const link of links) counts[link.status as keyof typeof counts] += 1;
    const needsRevalidation = links.filter(
      (link) => link.revalidationState === 'needs_revalidation',
    ).length;
    // 单一摘要状态按“需复核 > 待确认 > 已确认 > 无证据 > 拒绝 > 失效”排序，优先暴露需要人工处理的关系。
    return {
      counts,
      needsRevalidation,
      total: links.length,
      state:
        needsRevalidation > 0
          ? 'needs_revalidation'
          : counts.suggested > 0
            ? 'suggested'
            : counts.confirmed > 0
              ? 'confirmed'
              : links.length === 0
                ? 'none'
                : counts.rejected > 0
                  ? 'rejected'
                  : 'expired',
    };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const match = /^offset:(\d+)$/u.exec(decoded);
      if (!match) throw new Error('invalid cursor');
      const offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid offset');
      return offset;
    } catch {
      throw new DomainError('PAGINATION_CURSOR_INVALID', '分页游标无效', { httpStatus: 422 });
    }
  }
}
