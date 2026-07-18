import { Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { apiResponse, DomainError, errorCodes } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';
import { BackupHandlers } from './backup.handlers.js';
import { z } from 'zod';

const restoreSchema = z
  .object({
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    confirmationText: z.string().min(1).max(300),
    acknowledgedRestart: z.literal(true),
  })
  .strict();

@Controller()
export class BackupController {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
    private readonly handlers: BackupHandlers,
  ) {}

  @Post('maintenance/backup')
  public async create(@Req() request: FastifyRequest) {
    const minute = new Date().toISOString().slice(0, 16);
    const job = await this.queue.enqueue({
      type: 'backup.create',
      payloadSummary: { trigger: 'manual' },
      priority: 50,
      maxAttempts: 2,
      dedupeKey: `backup.manual:${minute}`,
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'backup.requested',
      targetType: 'job',
      targetId: job.id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Get('backups')
  public async list(@Req() request: FastifyRequest) {
    const rows = await this.prisma.backupArtifact.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const data = rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes?.toString() ?? null,
      status: row.status,
      schemaChecksum: row.schemaChecksum,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
    }));
    return apiResponse(data, request.autoWork.correlationId, { asOf: new Date().toISOString() });
  }

  @Post('backups/:id/verify')
  public async verify(@Param('id') id: string, @Req() request: FastifyRequest) {
    const artifact = await this.prisma.backupArtifact.findUnique({ where: { id } });
    if (!artifact)
      throw new DomainError(errorCodes.notFound, '备份记录不存在', { httpStatus: 404 });
    const job = await this.queue.enqueue({
      type: 'backup.verify',
      payloadRef: id,
      payloadSummary: { artifactId: id },
      priority: 60,
      maxAttempts: 1,
      dedupeKey: `backup.verify:${id}:${artifact.sha256 ?? 'pending'}`,
    });
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Get('backups/:id/restore-preflight')
  public async restorePreflight(@Param('id') id: string, @Req() request: FastifyRequest) {
    const preflight = await this.handlers.restorePreflight(id);
    if (!preflight)
      throw new DomainError(errorCodes.notFound, '备份记录不存在', { httpStatus: 404 });
    return apiResponse(preflight, request.autoWork.correlationId);
  }

  @Post('backups/:id/restore')
  public async restore(@Param('id') id: string, @Req() request: FastifyRequest) {
    const input = restoreSchema.parse(request.body);
    const preflight = await this.handlers.restorePreflight(id);
    if (!preflight)
      throw new DomainError(errorCodes.notFound, '备份记录不存在', { httpStatus: 404 });
    if (!preflight.compatible || !preflight.sha256 || !preflight.confirmationText) {
      throw new DomainError('BACKUP_RESTORE_PREFLIGHT_FAILED', '备份尚未通过恢复兼容性预检', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
    if (
      input.expectedSha256 !== preflight.sha256 ||
      input.confirmationText !== preflight.confirmationText
    ) {
      throw new DomainError('BACKUP_RESTORE_CONFIRMATION_MISMATCH', '恢复确认文本或哈希已变化', {
        httpStatus: 409,
        suggestedAction: 'refresh',
      });
    }
    const job = await this.queue.enqueue({
      type: 'backup.restore.prepare',
      payloadRef: id,
      payloadSummary: { artifactId: id, sha256: preflight.sha256 },
      priority: 10,
      maxAttempts: 1,
      dedupeKey: `backup.restore.prepare:${id}:${preflight.sha256}`,
    });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'backup.restore_requested',
      targetType: 'backup_artifact',
      targetId: id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: { jobId: job.id, acknowledgedRestart: input.acknowledgedRestart },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Get('maintenance/pending-restore')
  public async pendingRestore(@Req() request: FastifyRequest) {
    return apiResponse(await this.handlers.pendingRestore(), request.autoWork.correlationId);
  }

  @Delete('maintenance/pending-restore')
  public async cancelPendingRestore(@Req() request: FastifyRequest) {
    const pending = await this.handlers.cancelPendingRestore();
    if (!pending)
      throw new DomainError(errorCodes.notFound, '当前没有待应用的恢复', { httpStatus: 404 });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'backup.restore_cancelled',
      targetType: 'backup_artifact',
      targetId: pending.artifactId,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      before: pending,
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(
      { cancelled: true, restoreId: pending.restoreId },
      request.autoWork.correlationId,
    );
  }
}
