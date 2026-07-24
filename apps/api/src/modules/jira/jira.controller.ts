import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { apiResponse, DomainError, errorCodes } from '@auto-work/contracts';
import { requestHash, newId } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';

const syncSchema = z
  .object({
    scope: z.enum(['default', 'weekly', 'quarterly', 'incremental', 'full']),
    periodStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    periodEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (['weekly', 'quarterly'].includes(value.scope) && (!value.periodStart || !value.periodEnd)) {
      context.addIssue({
        code: 'custom',
        message: '周报和季度同步必须提供开始与结束日期',
      });
    }
  });

@Controller('integrations/:id/jira')
export class JiraController {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Get('capabilities')
  public async capabilities(@Param('id') id: string, @Req() request: FastifyRequest) {
    const connection = await this.connection(id);
    const mapping = await this.prisma.fieldMappingVersion.findFirst({
      where: { connectionId: id },
      orderBy: { versionNo: 'desc' },
    });
    const cursors = await this.prisma.syncCursor.findMany({
      where: { connectionId: id },
      orderBy: { scope: 'asc' },
    });
    return apiResponse(
      {
        status: connection.status,
        capabilities: JSON.parse(connection.capabilitiesJson) as unknown,
        automaticReadConfig: mapping
          ? {
              id: mapping.id,
              versionNo: mapping.versionNo,
              effectiveAt: mapping.effectiveAt.toISOString(),
            }
          : null,
        cursors: cursors.map((cursor) => ({
          scope: cursor.scope,
          lastUpdatedAt: cursor.lastUpdatedAt?.toISOString() ?? null,
          lastTiebreaker: cursor.lastTiebreaker,
          overlapSeconds: cursor.overlapSeconds,
          lastSuccessRunId: cursor.lastSuccessRunId,
        })),
      },
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Post('sync')
  public async sync(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = syncSchema.parse(rawBody);
    const connection = await this.connection(id);
    if (!connection.enabled)
      throw new DomainError('JIRA_CONNECTION_DISABLED', 'Jira 连接已禁用', { httpStatus: 409 });
    if (!connection.credentialRef)
      throw new DomainError('JIRA_CREDENTIAL_REQUIRED', '请先配置并验证 Jira Token', {
        httpStatus: 422,
      });
    const mapping = await this.prisma.fieldMappingVersion.findFirst({
      where: { connectionId: id },
      orderBy: { versionNo: 'desc' },
    });
    if (!mapping)
      throw new DomainError('JIRA_READ_CONFIG_REQUIRED', 'Jira 只读适配器尚未完成自动初始化', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    const dedupeKey = `jira.sync:${id}:${body.scope}`;
    const existing = await this.prisma.job.findFirst({
      where: { dedupeKey, status: { in: ['queued', 'running'] } },
    });
    if (existing) return this.operation(existing, request.autoWork.correlationId);
    const run = await this.prisma.jiraSyncRun.create({
      data: {
        id: newId(),
        connectionId: id,
        scope: body.scope,
        trigger: 'manual',
        status: 'queued',
        mappingVersionId: mapping.id,
        queryHash: requestHash(body),
        requestJson: JSON.stringify(body),
        startedAt: new Date(),
      },
    });
    const job = await this.queue.enqueue({
      type: 'jira.sync',
      payloadRef: run.id,
      payloadSummary: { connectionId: id, scope: body.scope, runId: run.id },
      priority: 40,
      maxAttempts: 3,
      dedupeKey,
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'jira.sync_requested',
      targetType: 'jira_sync_run',
      targetId: run.id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: { connectionId: id, scope: body.scope, mappingVersionId: mapping.id },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return this.operation(job, request.autoWork.correlationId, run.id);
  }

  @Get('sync-runs')
  public async runs(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.connection(id);
    const runs = await this.prisma.jiraSyncRun.findMany({
      where: { connectionId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    return apiResponse(
      runs.map((run) => ({
        id: run.id,
        scope: run.scope,
        trigger: run.trigger,
        status: run.status,
        mappingVersionId: run.mappingVersionId,
        counts: {
          pages: run.pageCount,
          read: run.readCount,
          created: run.createdCount,
          updated: run.updatedCount,
          unchanged: run.unchangedCount,
          errors: run.errorCount,
        },
        errorCode: run.errorCode,
        errorSummary: run.errorSummary,
        cursorBefore: JSON.parse(run.cursorBeforeJson) as unknown,
        cursorAfter: JSON.parse(run.cursorAfterJson) as unknown,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
      request.autoWork.correlationId,
    );
  }

  private async connection(id: string) {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id, type: 'jira' },
    });
    if (!connection)
      throw new DomainError(errorCodes.notFound, 'Jira 连接不存在', { httpStatus: 404 });
    return connection;
  }

  private operation(
    job: { id: string; status: string; payloadRef: string | null },
    correlationId: string,
    runId = job.payloadRef,
  ) {
    return apiResponse(
      {
        operationId: job.id,
        runId,
        status: job.status,
        statusUrl: `/api/v1/operations/${job.id}`,
      },
      correlationId,
    );
  }
}
