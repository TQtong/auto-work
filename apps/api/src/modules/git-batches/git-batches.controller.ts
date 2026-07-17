import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { AuditService } from '../audit/audit.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import {
  approveGitBatchSchema,
  cancelGitBatchSchema,
  previewGitBatchSchema,
} from './git-batch.schemas.js';
import { GitBatchService } from './git-batch.service.js';

@Controller('git/batches')
export class GitBatchesController {
  public constructor(
    private readonly batches: GitBatchService,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  @Get()
  public async list(@Query('limit') limit: string | undefined, @Req() request: FastifyRequest) {
    const parsedLimit = limit && /^\d+$/u.test(limit) ? Number(limit) : 20;
    return apiResponse(await this.batches.list(parsedLimit), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Post('preview')
  @HttpCode(202)
  public async preview(@Body() body: unknown, @Req() request: FastifyRequest) {
    const result = await this.batches.createPreview(
      previewGitBatchSchema.parse(body),
      this.sessions.currentProfileId,
    );
    await this.recordAudit(request, 'git.batch.preview_requested', 'git_batch', result.batchId);
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Get(':id')
  public async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.batches.get(id), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Post(':id/approve')
  @HttpCode(202)
  public async approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = approveGitBatchSchema.parse(body);
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Git 批准必须提供格式有效的 Idempotency-Key',
        {
          httpStatus: 422,
        },
      );
    }
    const route = `/api/v1/git/batches/${id}/approve`;
    const started = await this.idempotency.start({
      actorId: this.sessions.currentProfileId,
      route,
      key,
      requestHash: requestHash({ batchId: id, ...input }),
    });
    if (started.kind === 'replay') {
      return apiResponse(started.response, request.autoWork.correlationId);
    }
    if (started.kind === 'processing') {
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同批准请求正在处理中', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      const result = await this.batches.approve(id, input, this.sessions.currentProfileId);
      await this.idempotency.complete(started.recordId, 202, result);
      await this.recordAudit(request, 'git.batch.approved', 'git_batch', id, requestHash(input));
      return apiResponse(result, request.autoWork.correlationId);
    } catch (error) {
      await this.idempotency.fail(
        started.recordId,
        error instanceof DomainError ? error.code : 'GIT_BATCH_APPROVAL_FAILED',
      );
      throw error;
    }
  }

  @Post(':id/cancel')
  public async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = cancelGitBatchSchema.parse(body);
    const result = await this.batches.cancel(id, input.reason);
    await this.recordAudit(request, 'git.batch.cancelled', 'git_batch', id);
    return apiResponse(result, request.autoWork.correlationId);
  }

  private async recordAudit(
    request: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string,
    approvalId?: string,
  ) {
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action,
      targetType,
      targetId,
      correlationId: request.autoWork.correlationId,
      ...(approvalId ? { approvalId } : {}),
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
  }
}
