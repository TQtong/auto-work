import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { apiResponse, DomainError, errorCodes } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { SessionService } from '../session/session.service.js';

@Controller()
export class BackupController {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueueService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
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
}
