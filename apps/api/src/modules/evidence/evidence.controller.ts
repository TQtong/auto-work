import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';
import { EvidenceLifecycleService } from './evidence-lifecycle.service.js';
import {
  batchConfirmEvidenceLinksSchema,
  confirmEvidenceLinkSchema,
  createManualEvidenceLinkSchema,
  rejectEvidenceLinkSchema,
  revokeEvidenceDecisionSchema,
} from './evidence.schemas.js';

const taskEvidenceQuerySchema = z
  .object({ status: z.enum(['suggested', 'confirmed', 'rejected', 'expired']).optional() })
  .strict();

const evidenceCatalogQuerySchema = z
  .object({
    sourceType: z
      .enum(['branch', 'commit', 'merge_request', 'pipeline', 'tag', 'release', 'manual'])
      .optional(),
    availability: z.enum(['available', 'stale', 'unavailable']).optional(),
    projectId: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

@Controller()
export class EvidenceController {
  public constructor(
    private readonly lifecycle: EvidenceLifecycleService,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
    private readonly audit: AuditService,
  ) {}

  @Get('tasks/:id/evidence')
  public async taskEvidence(
    @Param('id') taskId: string,
    @Query() rawQuery: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const query = taskEvidenceQuerySchema.parse(rawQuery);
    return apiResponse(
      await this.lifecycle.listTaskEvidence(taskId, query.status),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Get('evidence')
  public async catalog(@Query() rawQuery: Record<string, unknown>, @Req() request: FastifyRequest) {
    const query = evidenceCatalogQuerySchema.parse(rawQuery);
    return apiResponse(
      await this.lifecycle.listEvidence({
        limit: query.limit,
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.availability ? { availability: query.availability } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Post('evidence-links/batch-confirm')
  @HttpCode(200)
  public async batchConfirm(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = batchConfirmEvidenceLinksSchema.parse(body);
    return this.mutate('/api/v1/evidence-links/batch-confirm', key, input, request, (recordId) =>
      this.lifecycle.batchConfirm(input, this.context(request, recordId)),
    );
  }

  @Post('evidence-links/:id/confirm')
  @HttpCode(200)
  public async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = confirmEvidenceLinkSchema.parse(body);
    return this.mutate(
      `/api/v1/evidence-links/${id}/confirm`,
      key,
      { id, ...input },
      request,
      (recordId) => this.lifecycle.confirm(id, input, this.context(request, recordId)),
    );
  }

  @Post('evidence-links/:id/reject')
  @HttpCode(200)
  public async reject(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = rejectEvidenceLinkSchema.parse(body);
    return this.mutate(
      `/api/v1/evidence-links/${id}/reject`,
      key,
      { id, ...input },
      request,
      (recordId) => this.lifecycle.reject(id, input, this.context(request, recordId)),
    );
  }

  @Post('evidence-links')
  @HttpCode(200)
  public async createManual(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = createManualEvidenceLinkSchema.parse(body);
    return this.mutate('/api/v1/evidence-links', key, input, request, (recordId) =>
      this.lifecycle.createManual(input, this.context(request, recordId)),
    );
  }

  @Delete('evidence-links/:id/confirmation')
  @HttpCode(200)
  public async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = revokeEvidenceDecisionSchema.parse(body);
    return this.mutate(
      `/api/v1/evidence-links/${id}/confirmation`,
      key,
      { id, ...input },
      request,
      (recordId) => this.lifecycle.revoke(id, input, this.context(request, recordId)),
    );
  }

  private async mutate(
    route: string,
    key: string | undefined,
    input: unknown,
    request: FastifyRequest,
    operation: (recordId: string) => Promise<unknown>,
  ) {
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        '证据关系写操作必须提供格式有效的 Idempotency-Key',
        { httpStatus: 422 },
      );
    }
    const started = await this.idempotency.start({
      actorId: this.sessions.currentProfileId,
      route,
      key,
      requestHash: requestHash(input),
    });
    if (started.kind === 'replay') {
      return apiResponse(started.response, request.autoWork.correlationId);
    }
    if (started.kind === 'processing') {
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同证据关系请求正在处理中', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      return apiResponse(await operation(started.recordId), request.autoWork.correlationId);
    } catch (error) {
      const errorCode = error instanceof DomainError ? error.code : 'EVIDENCE_MUTATION_FAILED';
      await this.idempotency.fail(started.recordId, errorCode);
      await this.audit.record({
        actorId: this.sessions.currentProfileId,
        action: 'evidence.mutation_rejected',
        targetType: 'evidence_mutation',
        targetId: route,
        correlationId: request.autoWork.correlationId,
        outcome: error instanceof DomainError ? 'rejected' : 'failed',
        after: { requestHash: requestHash(input) },
        errorCode,
        clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
      });
      throw error;
    }
  }

  private context(request: FastifyRequest, idempotencyRecordId: string) {
    return {
      actorId: this.sessions.currentProfileId,
      correlationId: request.autoWork.correlationId,
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
      idempotencyRecordId,
    };
  }
}
