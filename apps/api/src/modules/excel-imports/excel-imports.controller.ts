import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { sha256 } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { ExcelImportPreviewService } from './excel-import-preview.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;

@Controller('excel-imports')
export class ExcelImportsController {
  public constructor(
    private readonly previews: ExcelImportPreviewService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Post('preview')
  public async preview(@Req() request: FastifyRequest) {
    if (!request.isMultipart()) {
      throw new DomainError('EXCEL_MULTIPART_REQUIRED', '请使用 multipart/form-data 上传 XLSX', {
        httpStatus: 415,
      });
    }
    let part;
    let buffer: Buffer;
    try {
      part = await request.file({
        limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 0, parts: 1 },
      });
      if (!part) {
        throw new DomainError('EXCEL_FILE_REQUIRED', '必须上传一个 XLSX 文件', {
          httpStatus: 422,
        });
      }
      buffer = await part.toBuffer();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('EXCEL_UPLOAD_REJECTED', 'Excel 上传超过限制或 multipart 结构无效', {
        httpStatus: 413,
        details: { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      });
    }
    let result: Awaited<ReturnType<ExcelImportPreviewService['preview']>>;
    try {
      result = await this.previews.preview({
        buffer,
        fileName: part.filename,
        mimeType: part.mimetype,
      });
    } catch (error) {
      const domainError = error instanceof DomainError ? error : null;
      const details =
        domainError?.options.details && typeof domainError.options.details === 'object'
          ? (domainError.options.details as Record<string, unknown>)
          : {};
      await this.audit.record({
        actorId: this.sessions.currentProfileId,
        action: 'excel.preview_failed',
        targetType: 'excel_import',
        targetId: typeof details.importId === 'string' ? details.importId : 'unpersisted',
        correlationId: request.autoWork.correlationId,
        outcome: 'failed',
        errorCode: domainError?.code ?? 'EXCEL_PREVIEW_FAILED',
        after: { fileSha256: sha256(buffer) },
        clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
      });
      throw error;
    }
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: result.replayed ? 'excel.preview_replayed' : 'excel.preview_created',
      targetType: 'excel_import',
      targetId: result.import.id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: {
        fileSha256: result.import.fileSha256,
        counts: result.import.counts,
        replayed: result.replayed,
      },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Get()
  public async list(@Req() request: FastifyRequest) {
    return apiResponse(await this.previews.list(), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Get(':id')
  public async detail(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.previews.detail(id), request.autoWork.correlationId);
  }
}
