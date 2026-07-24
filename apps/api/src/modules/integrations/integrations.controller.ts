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
  Req,
} from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';
import { IntegrationsService } from './integrations.service.js';
import { DingTalkTemplateMappingService } from './dingtalk-template-mapping.service.js';
import { saveDingTalkTemplateMappingSchema } from './dingtalk-template-mapping.schemas.js';

const integrationTypeSchema = z.enum([
  'gitlab',
  'jira',
  'dingtalk_log',
  'dingtalk_desktop',
  'dingtalk_robot',
  'ai',
]);
const credentialSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(4_096));
const createSchema = z
  .object({
    type: integrationTypeSchema,
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().trim().max(2_048).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    credential: credentialSchema.optional(),
  })
  .strict();
const updateSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().max(2_048).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credential: credentialSchema.optional(),
  })
  .strict();
const versionSchema = z.object({ version: z.number().int().positive() }).strict();
const dingtalkRobotTestSchema = z.object({ confirmSendTestMessage: z.literal(true) }).strict();

@Controller('integrations')
export class IntegrationsController {
  public constructor(
    private readonly integrations: IntegrationsService,
    private readonly dingtalkMappings: DingTalkTemplateMappingService,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  public async list(@Req() request: FastifyRequest) {
    return apiResponse(await this.integrations.list(), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Post()
  public async create(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const body = createSchema.parse(rawBody);
    const connection = await this.integrations.create(body, this.context(request));
    return apiResponse(connection, request.autoWork.correlationId);
  }

  @Put(':id')
  public async update(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = updateSchema.parse(rawBody);
    const connection = await this.integrations.update(id, body, this.context(request));
    return apiResponse(connection, request.autoWork.correlationId);
  }

  @Post(':id/test')
  public async test(@Param('id') id: string, @Req() request: FastifyRequest) {
    const job = await this.integrations.test(id, this.context(request));
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
    );
  }

  @Post(':id/dingtalk-robot/test')
  @HttpCode(202)
  public async testDingTalkRobot(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const body = dingtalkRobotTestSchema.parse(rawBody);
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        '钉钉机器人测试必须提供格式有效的 Idempotency-Key',
        { httpStatus: 422 },
      );
    }
    const route = `/api/v1/integrations/${id}/dingtalk-robot/test`;
    const started = await this.idempotency.start({
      actorId: this.sessions.currentProfileId,
      route,
      key,
      requestHash: requestHash({ connectionId: id, ...body }),
    });
    if (started.kind === 'replay') {
      return apiResponse(started.response, request.autoWork.correlationId);
    }
    if (started.kind === 'processing') {
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同机器人测试正在处理中', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      const result = await this.integrations.testDingTalkRobot(
        id,
        this.context(request),
        started.recordId,
      );
      return apiResponse(result, request.autoWork.correlationId);
    } catch (error) {
      await this.idempotency.fail(
        started.recordId,
        error instanceof DomainError ? error.code : 'DINGTALK_ROBOT_TEST_QUEUE_FAILED',
      );
      throw error;
    }
  }

  @Get(':id/dingtalk/template-mappings')
  public async listDingTalkTemplateMappings(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(await this.dingtalkMappings.list(id), request.autoWork.correlationId);
  }

  @Post(':id/dingtalk/template-mappings')
  public async saveDingTalkTemplateMapping(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = saveDingTalkTemplateMappingSchema.parse(rawBody);
    return apiResponse(
      await this.dingtalkMappings.save(id, body, this.context(request)),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/dingtalk/recipients')
  public async listDingTalkRecipients(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(
      await this.dingtalkMappings.listRecipientCache(id),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Post(':id/disable')
  public async disable(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = versionSchema.parse(rawBody);
    const connection = await this.integrations.disable(id, body.version, this.context(request));
    return apiResponse(connection, request.autoWork.correlationId);
  }

  @Delete(':id/credential')
  public async revokeCredential(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = versionSchema.parse(rawBody);
    const connection = await this.integrations.revokeCredential(
      id,
      body.version,
      this.context(request),
    );
    return apiResponse(connection, request.autoWork.correlationId);
  }

  private context(request: FastifyRequest) {
    return {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    };
  }
}
