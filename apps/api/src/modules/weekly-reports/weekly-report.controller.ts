import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';
import {
  adoptWeeklyAiSuggestionSchema,
  confirmWeeklyReportSchema,
  createWeeklyAiSuggestionSchema,
  editWeeklyReportSchema,
  generateWeeklyReportSchema,
  listWeeklyReportsQuerySchema,
  notifyWeeklyReportGroupSchema,
  notifyWeeklyReportFailureSchema,
  reconcileWeeklyReportDeliverySchema,
  notifyWeeklyReportRiskSchema,
  rejectWeeklyAiSuggestionSchema,
  resolveWeeklyReportDeliverySchema,
  restoreWeeklyReportVersionSchema,
  retryWeeklyReportDeliverySchema,
  submitWeeklyReportLogSchema,
  updateWeeklyReminderPolicySchema,
} from './weekly-report.schemas.js';
import { WeeklyReportAttachmentService } from './weekly-report-attachment.service.js';
import { WeeklyReportAiService } from './weekly-report-ai.service.js';
import { WeeklyReportDeliveryService } from './weekly-report-delivery.service.js';
import { WeeklyReportDeliveryRecoveryService } from './weekly-report-delivery-recovery.service.js';
import { WeeklyReportNotificationService } from './weekly-report-notification.service.js';
import { WeeklyReportReminderPolicyService } from './weekly-report-reminder-policy.service.js';
import { WeeklyReportService } from './weekly-report.service.js';

const maxAttachmentBytes = 8 * 1024 * 1024;

@Controller('weekly-reports')
export class WeeklyReportController {
  public constructor(
    private readonly reports: WeeklyReportService,
    private readonly ai: WeeklyReportAiService,
    private readonly attachments: WeeklyReportAttachmentService,
    private readonly delivery: WeeklyReportDeliveryService,
    private readonly deliveryRecovery: WeeklyReportDeliveryRecoveryService,
    private readonly notifications: WeeklyReportNotificationService,
    private readonly reminderPolicy: WeeklyReportReminderPolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly security: LocalSecurityService,
  ) {}

  @Get('reminder-policy')
  public async getReminderPolicy(@Req() request: FastifyRequest) {
    return apiResponse(await this.reminderPolicy.get(), request.autoWork.correlationId);
  }

  @Put('reminder-policy')
  public async updateReminderPolicy(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const input = updateWeeklyReminderPolicySchema.parse(rawBody);
    return apiResponse(
      await this.reminderPolicy.update(input, {
        correlationId: request.autoWork.correlationId,
        sessionId: request.autoWork.sessionId,
      }),
      request.autoWork.correlationId,
    );
  }

  @Post('generate')
  @HttpCode(202)
  public async generate(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const input = generateWeeklyReportSchema.parse(rawBody);
    return apiResponse(
      await this.reports.generate(input, {
        correlationId: request.autoWork.correlationId,
        sessionId: request.autoWork.sessionId,
      }),
      request.autoWork.correlationId,
    );
  }

  @Get()
  public async list(@Query() rawQuery: Record<string, unknown>, @Req() request: FastifyRequest) {
    const query = listWeeklyReportsQuerySchema.parse(rawQuery);
    return apiResponse(await this.reports.list(query), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Get(':id/deliveries')
  public async deliveries(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.delivery.list(id), request.autoWork.correlationId);
  }

  @Get(':id/notifications')
  public async notificationList(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.notifications.list(id), request.autoWork.correlationId);
  }

  @Post(':id/notifications/risk')
  @HttpCode(202)
  public async notifyRisk(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = notifyWeeklyReportRiskSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/notifications/risk`,
      key,
      { id, ...input },
      request,
      (recordId) => this.notifications.notifyRisk(id, input, this.context(request, recordId)),
    );
  }

  @Get(':id')
  public async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.reports.get(id), request.autoWork.correlationId);
  }

  @Get(':id/versions')
  public async versions(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.reports.listVersions(id), request.autoWork.correlationId);
  }

  @Get(':id/versions/:versionId')
  public async version(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.reports.getVersion(id, versionId),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/ai-suggestions')
  public async createAiSuggestion(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = createWeeklyAiSuggestionSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/ai-suggestions`,
      key,
      { id, ...input },
      request,
      (recordId) => this.ai.createSuggestion(id, input, this.context(request, recordId)),
    );
  }

  @Get(':id/ai-generations')
  public async listAiGenerations(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.ai.list(id), request.autoWork.correlationId);
  }

  @Get(':id/ai-generations/:generationId')
  public async getAiGeneration(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(await this.ai.get(id, generationId), request.autoWork.correlationId);
  }

  @Post(':id/ai-generations/:generationId/adopt')
  public async adoptAiSuggestion(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = adoptWeeklyAiSuggestionSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/ai-generations/${generationId}/adopt`,
      key,
      { id, generationId, ...input },
      request,
      (recordId) => this.ai.adopt(id, generationId, input, this.context(request, recordId)),
    );
  }

  @Post(':id/ai-generations/:generationId/reject')
  public async rejectAiSuggestion(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = rejectWeeklyAiSuggestionSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/ai-generations/${generationId}/reject`,
      key,
      { id, generationId, ...input },
      request,
      (recordId) => this.ai.reject(id, generationId, input, this.context(request, recordId)),
    );
  }

  @Put(':id')
  public async edit(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = editWeeklyReportSchema.parse(rawBody);
    return this.mutate(`/api/v1/weekly-reports/${id}`, key, { id, ...input }, request, (recordId) =>
      this.reports.edit(id, input, this.context(request, recordId)),
    );
  }

  @Post(':id/versions/:versionId/restore')
  public async restore(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = restoreWeeklyReportVersionSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/versions/${versionId}/restore`,
      key,
      { id, versionId, ...input },
      request,
      (recordId) => this.reports.restore(id, versionId, input, this.context(request, recordId)),
    );
  }

  @Post(':id/confirm')
  public async confirm(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = confirmWeeklyReportSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/confirm`,
      key,
      { id, ...input },
      request,
      (recordId) => this.reports.confirm(id, input, this.context(request, recordId)),
    );
  }

  @Post(':id/submit-log')
  @HttpCode(202)
  public async submitLog(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = submitWeeklyReportLogSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/submit-log`,
      key,
      { id, ...input },
      request,
      (recordId) => this.delivery.submitLog(id, input, this.context(request, recordId)),
    );
  }

  @Post(':id/notify-group')
  @HttpCode(202)
  public async notifyGroup(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = notifyWeeklyReportGroupSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/notify-group`,
      key,
      { id, ...input },
      request,
      (recordId) => this.delivery.notifyGroup(id, input, this.context(request, recordId)),
    );
  }

  @Post(':id/notifications/failure')
  @HttpCode(202)
  public async notifyFailure(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = notifyWeeklyReportFailureSchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/notifications/failure`,
      key,
      { id, ...input },
      request,
      (recordId) => this.notifications.notifyFailure(id, input, this.context(request, recordId)),
    );
  }

  @Post(':id/deliveries/:intentId/reconcile')
  public async reconcileDelivery(
    @Param('id') id: string,
    @Param('intentId') intentId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = reconcileWeeklyReportDeliverySchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/deliveries/${intentId}/reconcile`,
      key,
      { id, intentId, ...input },
      request,
      (recordId) =>
        this.deliveryRecovery.reconcile(id, intentId, input, this.context(request, recordId)),
    );
  }

  @Post(':id/deliveries/:intentId/resolve')
  public async resolveDelivery(
    @Param('id') id: string,
    @Param('intentId') intentId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = resolveWeeklyReportDeliverySchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/deliveries/${intentId}/resolve`,
      key,
      { id, intentId, ...input },
      request,
      (recordId) =>
        this.deliveryRecovery.resolve(id, intentId, input, this.context(request, recordId)),
    );
  }

  @Post(':id/deliveries/:intentId/retry')
  @HttpCode(202)
  public async retryDelivery(
    @Param('id') id: string,
    @Param('intentId') intentId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = retryWeeklyReportDeliverySchema.parse(rawBody);
    return this.mutate(
      `/api/v1/weekly-reports/${id}/deliveries/${intentId}/retry`,
      key,
      { id, intentId, ...input },
      request,
      (recordId) =>
        this.deliveryRecovery.retry(id, intentId, input, this.context(request, recordId)),
    );
  }

  @Get(':id/attachments')
  public async listAttachments(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.attachments.list(id), request.autoWork.correlationId);
  }

  @Post(':id/attachments')
  public async uploadAttachment(@Param('id') id: string, @Req() request: FastifyRequest) {
    if (!request.isMultipart()) {
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_MULTIPART_REQUIRED',
        '请使用 multipart/form-data 上传周报附件',
        { httpStatus: 415 },
      );
    }
    let part;
    let buffer: Buffer;
    try {
      part = await request.file({
        limits: { files: 1, fileSize: maxAttachmentBytes, fields: 0, parts: 1 },
      });
      if (!part) {
        throw new DomainError('WEEKLY_REPORT_ATTACHMENT_REQUIRED', '必须上传一个附件', {
          httpStatus: 422,
        });
      }
      buffer = await part.toBuffer();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'WEEKLY_REPORT_ATTACHMENT_UPLOAD_REJECTED',
        '附件超过 8 MiB 或 multipart 结构无效',
        { httpStatus: 413 },
      );
    }
    const attachment = await this.attachments.upload(
      id,
      { buffer, fileName: part.filename, mimeType: part.mimetype },
      {
        correlationId: request.autoWork.correlationId,
        sessionId: request.autoWork.sessionId,
      },
    );
    return apiResponse(attachment, request.autoWork.correlationId);
  }

  @Delete(':id/attachments/:attachmentId')
  public async removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.attachments.remove(id, attachmentId, {
        correlationId: request.autoWork.correlationId,
        sessionId: request.autoWork.sessionId,
      }),
      request.autoWork.correlationId,
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
        '周报版本与确认写操作必须提供格式有效的 Idempotency-Key',
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
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同周报请求正在处理', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      return apiResponse(await operation(started.recordId), request.autoWork.correlationId);
    } catch (error) {
      const errorCode = error instanceof DomainError ? error.code : 'WEEKLY_REPORT_MUTATION_FAILED';
      await this.idempotency.fail(started.recordId, errorCode);
      await this.audit.record({
        actorId: this.sessions.currentProfileId,
        action: 'weekly_report.mutation_rejected',
        targetType: 'weekly_report_mutation',
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
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
      idempotencyRecordId,
    };
  }
}
