import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { apiResponse, DomainError, errorCodes } from '@auto-work/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { RetentionService } from './retention.service.js';

const createBundleSchema = z
  .object({
    acknowledgedExclusions: z.literal(true),
    includeRecentErrors: z.boolean().default(true),
  })
  .strict();

const bundleIdSchema = z.uuid();
const retentionPolicySchema = z
  .object({
    eventLogDays: z.number().int().min(7).max(3650),
    terminalJobDays: z.number().int().min(30).max(3650),
    diagnosticBundleDays: z.number().int().min(7).max(3650),
  })
  .strict();
const retentionExecuteSchema = retentionPolicySchema.extend({
  acknowledgedPreservationBoundary: z.literal(true),
  expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

@Controller('maintenance')
export class DiagnosticsController {
  public constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
    private readonly retention: RetentionService,
  ) {}

  @Post('retention/preview')
  public async retentionPreview(@Req() request: FastifyRequest) {
    const policy = retentionPolicySchema.parse(request.body);
    return apiResponse(await this.retention.preview(policy), request.autoWork.correlationId);
  }

  @Post('retention/execute')
  public async retentionExecute(@Req() request: FastifyRequest) {
    const input = retentionExecuteSchema.parse(request.body);
    const policy = {
      eventLogDays: input.eventLogDays,
      terminalJobDays: input.terminalJobDays,
      diagnosticBundleDays: input.diagnosticBundleDays,
    };
    const result = await this.retention.execute(policy, input.expectedPreviewHash);
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'retention.executed',
      targetType: 'maintenance',
      targetId: result.previewHash,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: { policy, deleted: result.deleted },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Get('diagnostics')
  public async get(@Req() request: FastifyRequest) {
    return apiResponse(await this.diagnostics.facts(), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Get('diagnostic-bundles/preview')
  public preview(@Req() request: FastifyRequest) {
    return apiResponse(
      {
        formatVersion: 'diagnostic-bundle-v1',
        includedSections: [
          '运行时与安全监听',
          'SQLite 完整性与容量',
          '受控数据目录分类大小',
          '作业状态计数',
          '集成健康计数',
          '备份年龄与审计数量',
          '最多 50 条结构化错误码',
        ],
        exclusions: this.diagnostics.exclusions(),
      },
      request.autoWork.correlationId,
    );
  }

  @Post('diagnostic-bundles')
  public async create(@Req() request: FastifyRequest) {
    const input = createBundleSchema.parse(request.body);
    const bundle = await this.diagnostics.createBundle(input.includeRecentErrors);
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'diagnostic_bundle.created',
      targetType: 'diagnostic_bundle',
      targetId: bundle.bundleId,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: { formatVersion: 'diagnostic-bundle-v1', includeRecentErrors: input.includeRecentErrors },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(bundle, request.autoWork.correlationId);
  }

  @Get('diagnostic-bundles')
  public async list(@Req() request: FastifyRequest) {
    return apiResponse(await this.diagnostics.listBundles(), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Get('diagnostic-bundles/:bundleId/download')
  public async download(
    @Param('bundleId') rawBundleId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const bundleId = bundleIdSchema.parse(rawBundleId);
    const bundle = await this.diagnostics.openBundle(bundleId);
    if (!bundle)
      throw new DomainError(errorCodes.notFound, '诊断包不存在', { httpStatus: 404 });
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'diagnostic_bundle.downloaded',
      targetType: 'diagnostic_bundle',
      targetId: bundle.bundleId,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${bundle.fileName}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(bundle.stream);
  }
}
