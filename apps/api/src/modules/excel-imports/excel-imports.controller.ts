import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash, sha256 } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';
import { ExcelImportCommitService } from './excel-import-commit.service.js';
import { commitExcelImportSchema, saveExcelResolutionsSchema } from './excel-import.schemas.js';
import { ExcelImportPreviewService } from './excel-import-preview.service.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;

@Controller('excel-imports')
export class ExcelImportsController {
  public constructor(
    private readonly previews: ExcelImportPreviewService,
    private readonly commits: ExcelImportCommitService,
    private readonly idempotency: IdempotencyService,
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

  @Put(':id/resolutions')
  public async saveResolutions(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = saveExcelResolutionsSchema.parse(body);
    const result = await this.commits.saveResolutions(id, input);
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'excel.resolutions_saved',
      targetType: 'excel_import',
      targetId: id,
      correlationId: request.autoWork.correlationId,
      outcome: 'succeeded',
      after: { version: result.version, rowCount: input.rows.length },
      clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
    });
    return apiResponse(result, request.autoWork.correlationId);
  }

  @Post(':id/commit')
  @HttpCode(200)
  public async commit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = commitExcelImportSchema.parse(body);
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Excel 导入提交必须提供格式有效的 Idempotency-Key',
        { httpStatus: 422 },
      );
    }
    const route = `/api/v1/excel-imports/${id}/commit`;
    const started = await this.idempotency.start({
      actorId: this.sessions.currentProfileId,
      route,
      key,
      requestHash: requestHash({ importId: id, ...input }),
    });
    if (started.kind === 'replay') {
      return apiResponse(started.response, request.autoWork.correlationId);
    }
    if (started.kind === 'processing') {
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同 Excel 提交正在处理中', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      const result = await this.commits.commit(id, input, started.recordId);
      await this.audit.record({
        actorId: this.sessions.currentProfileId,
        action: 'excel.import_committed',
        targetType: 'excel_import',
        targetId: id,
        correlationId: request.autoWork.correlationId,
        outcome: 'succeeded',
        after: result,
        clientSessionHash: this.security.sessionHash(request.autoWork.sessionId),
      });
      return apiResponse(result, request.autoWork.correlationId);
    } catch (error) {
      await this.idempotency.fail(
        started.recordId,
        error instanceof DomainError ? error.code : 'EXCEL_IMPORT_COMMIT_FAILED',
      );
      throw error;
    }
  }
}
