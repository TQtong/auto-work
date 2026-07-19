import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { apiResponse, cursorQuerySchema, errorCodes } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { DomainError } from '@auto-work/contracts';
import { z } from 'zod';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { JobQueueService } from './job-queue.service.js';

const jobsQuerySchema = cursorQuerySchema.extend({
  type: z.string().min(1).max(100).optional(),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'dead_letter'])
    .optional(),
});

@Controller('operations')
export class OperationsController {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Get()
  public async list(@Query() rawQuery: unknown, @Req() request: FastifyRequest) {
    const query = jobsQuerySchema.parse(rawQuery);
    const rows = await this.prisma.job.findMany({
      where: {
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const data = rows.slice(0, query.limit).map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      cancelRequested: job.cancelRequested,
      payloadSummary: JSON.parse(job.payloadSummary) as unknown,
      lastErrorCode: job.lastErrorCode,
      lastError: job.lastError,
      scheduledAt: job.scheduledAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    }));
    return {
      ...apiResponse(data, request.autoWork.correlationId, { asOf: new Date().toISOString() }),
      page: {
        cursor: query.cursor,
        nextCursor: hasMore ? data.at(-1)?.id : undefined,
        hasMore,
        limit: query.limit,
      },
    };
  }

  @Get(':id')
  public async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new DomainError(errorCodes.notFound, '操作不存在', { httpStatus: 404 });
    return apiResponse(
      {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        cancellable: ['queued', 'running'].includes(job.status),
        result: job.resultJson ? (JSON.parse(job.resultJson) as unknown) : undefined,
        error: job.lastErrorCode
          ? {
              code: job.lastErrorCode,
              message: job.lastError ?? '操作失败',
              retryable: job.status === 'queued',
            }
          : undefined,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString(),
        completedAt: job.completedAt?.toISOString(),
      },
      request.autoWork.correlationId,
    );
  }

  @Post(':id/cancel')
  public async cancel(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.queue.requestCancel(id);
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'operation.cancel_requested',
      targetType: 'job',
      targetId: id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse({ id, cancelRequested: true }, request.autoWork.correlationId);
  }
}
