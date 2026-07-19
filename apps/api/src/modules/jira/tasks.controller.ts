import { Body, Controller, Delete, Get, Optional, Param, Put, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { apiResponse, DomainError, errorCodes, normalizedTaskStatuses } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { SessionService } from '../session/session.service.js';
import { taskOverrideFields, TaskOverrideService } from './task-override.service.js';

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
    conflict: z.enum(['true', 'false']).optional(),
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

const overrideValueSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  z.number().int().min(0).max(315_576_000),
  z.null(),
]);
const taskOverrideSchema = z
  .object({
    fieldName: z.enum(taskOverrideFields),
    value: overrideValueSchema,
    reason: z.string().trim().min(3).max(1_000),
    expiresAt: z.iso.datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectsDate = ['plannedStartDate', 'dueDate'].includes(value.fieldName);
    if (expectsDate && value.value !== null && typeof value.value !== 'string') {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: '日期字段必须是 YYYY-MM-DD 或 null',
      });
    }
    if (!expectsDate && value.value !== null && typeof value.value !== 'number') {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: '工时字段必须是非负整数秒或 null',
      });
    }
    const expiresAt = new Date(value.expiresAt);
    const now = Date.now();
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + 366 * 24 * 60 * 60_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: '覆盖有效期必须在未来且不超过 366 天',
      });
    }
  });
const revokeOverrideSchema = z
  .object({ version: z.number().int().positive(), reason: z.string().trim().min(3).max(1_000) })
  .strict();
const conflictQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

@Controller('tasks')
export class TasksController {
  public constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly overrides?: TaskOverrideService,
    @Optional() private readonly sessions?: SessionService,
    @Optional() private readonly security?: LocalSecurityService,
  ) {}

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
      ...(query.conflict
        ? {
            fieldProvenances:
              query.conflict === 'true'
                ? {
                    some: {
                      sourceType: 'manual',
                      decision: 'override',
                      active: true,
                      conflictDetectedAt: { not: null },
                    },
                  }
                : {
                    none: {
                      sourceType: 'manual',
                      decision: 'override',
                      active: true,
                      conflictDetectedAt: { not: null },
                    },
                  },
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
          fieldProvenances: {
            where: { active: true },
            select: {
              fieldName: true,
              sourceType: true,
              decision: true,
              expiresAt: true,
              conflictDetectedAt: true,
            },
          },
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

  @Get('conflicts')
  public async conflicts(
    @Query() rawQuery: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const service = this.overrideDependencies().service;
    const result = await service.listConflicts(conflictQuerySchema.parse(rawQuery));
    return {
      ...apiResponse(result.items, request.autoWork.correlationId, {
        asOf: new Date().toISOString(),
      }),
      page: result.page,
      total: result.total,
    };
  }

  @Put(':id/overrides')
  public async setOverride(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const dependencies = this.overrideDependencies();
    const input = taskOverrideSchema.parse(rawBody);
    const result = await dependencies.service.setOverride(
      id,
      { ...input, expiresAt: new Date(input.expiresAt) },
      {
        actorId: dependencies.sessions.currentProfileId,
        correlationId: request.autoWork.correlationId,
        clientSessionHash: dependencies.security.sessionHash(request.autoWork.sessionId),
      },
    );
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Delete(':id/overrides/:fieldName')
  public async revokeOverride(
    @Param('id') id: string,
    @Param('fieldName') rawFieldName: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const dependencies = this.overrideDependencies();
    const fieldName = z.enum(taskOverrideFields).parse(rawFieldName);
    const input = revokeOverrideSchema.parse(rawBody);
    const result = await dependencies.service.revokeOverride(id, fieldName, input, {
      actorId: dependencies.sessions.currentProfileId,
      correlationId: request.autoWork.correlationId,
      clientSessionHash: dependencies.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Get(':id')
  public async detail(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ownerProfileId = this.sessions?.currentProfileId;
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
        reportSourceLinks: {
          // 只回看当前本机用户自己的周报版本，避免历史资料跨用户串读。
          ...(ownerProfileId
            ? { where: { version: { report: { ownerProfileId } } } }
            : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true,
            fieldName: true,
            blockId: true,
            sourceType: true,
            sourceSummaryJson: true,
            createdAt: true,
            version: {
              select: {
                id: true,
                versionNo: true,
                origin: true,
                createdAt: true,
                report: {
                  select: {
                    id: true,
                    periodStart: true,
                    periodEnd: true,
                    reportDate: true,
                    status: true,
                    currentVersionId: true,
                    confirmedVersionId: true,
                  },
                },
              },
            },
          },
        },
        achievementEvidences: {
          // 绩效引用以成果证据为入口，保留成果和季度评审的双层上下文。
          ...(ownerProfileId
            ? { where: { achievement: { review: { ownerProfileId } } } }
            : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true,
            sourceType: true,
            sourceId: true,
            title: true,
            contributionAngle: true,
            primaryEvidence: true,
            availabilityState: true,
            createdAt: true,
            achievement: {
              select: {
                id: true,
                title: true,
                selectionStatus: true,
                evidenceStatus: true,
                version: true,
                review: {
                  select: {
                    id: true,
                    name: true,
                    periodStart: true,
                    periodEnd: true,
                    status: true,
                    version: true,
                  },
                },
              },
            },
          },
        },
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
          expiresAt: provenance.expiresAt?.toISOString() ?? null,
          conflictValue: provenance.conflictValueJson
            ? (JSON.parse(provenance.conflictValueJson) as unknown)
            : null,
          conflictDetectedAt: provenance.conflictDetectedAt?.toISOString() ?? null,
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
        weeklyReportReferences: task.reportSourceLinks.map((link) => ({
          id: link.id,
          report: {
            id: link.version.report.id,
            periodStart: link.version.report.periodStart,
            periodEnd: link.version.report.periodEnd,
            reportDate: link.version.report.reportDate,
            status: link.version.report.status,
          },
          version: {
            id: link.version.id,
            versionNo: link.version.versionNo,
            origin: link.version.origin,
            current: link.version.report.currentVersionId === link.version.id,
            confirmed: link.version.report.confirmedVersionId === link.version.id,
            createdAt: link.version.createdAt.toISOString(),
          },
          fieldName: link.fieldName,
          blockId: link.blockId,
          sourceType: link.sourceType,
          sourceSummary: JSON.parse(link.sourceSummaryJson) as unknown,
          linkedAt: link.createdAt.toISOString(),
        })),
        quarterlyReviewReferences: task.achievementEvidences.map((evidence) => ({
          id: evidence.id,
          review: {
            id: evidence.achievement.review.id,
            name: evidence.achievement.review.name,
            periodStart: evidence.achievement.review.periodStart,
            periodEnd: evidence.achievement.review.periodEnd,
            status: evidence.achievement.review.status,
            version: evidence.achievement.review.version,
          },
          achievement: {
            id: evidence.achievement.id,
            title: evidence.achievement.title,
            selectionStatus: evidence.achievement.selectionStatus,
            evidenceStatus: evidence.achievement.evidenceStatus,
            version: evidence.achievement.version,
          },
          evidence: {
            sourceType: evidence.sourceType,
            sourceId: evidence.sourceId,
            title: evidence.title,
            contributionAngle: evidence.contributionAngle,
            primary: evidence.primaryEvidence,
            availabilityState: evidence.availabilityState,
          },
          linkedAt: evidence.createdAt.toISOString(),
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
    fieldProvenances?: Array<{
      fieldName: string;
      sourceType: string;
      decision: string;
      expiresAt: Date | null;
      conflictDetectedAt: Date | null;
    }>;
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
      fieldSources: Object.fromEntries(
        (task.fieldProvenances ?? []).map((provenance) => [
          provenance.fieldName,
          {
            sourceType: provenance.sourceType,
            decision: provenance.decision,
            expiresAt: provenance.expiresAt?.toISOString() ?? null,
            conflict: provenance.conflictDetectedAt !== null,
          },
        ]),
      ),
      conflictCount: (task.fieldProvenances ?? []).filter(
        (provenance) => provenance.conflictDetectedAt !== null,
      ).length,
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

  private overrideDependencies(): {
    service: TaskOverrideService;
    sessions: SessionService;
    security: LocalSecurityService;
  } {
    if (!this.overrides || !this.sessions || !this.security) {
      throw new DomainError('TASK_OVERRIDE_UNAVAILABLE', '任务覆盖服务未初始化', {
        httpStatus: 503,
      });
    }
    return { service: this.overrides, sessions: this.sessions, security: this.security };
  }
}
