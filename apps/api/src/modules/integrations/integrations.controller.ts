import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IntegrationsService } from './integrations.service.js';

const integrationTypeSchema = z.enum(['gitlab', 'jira', 'dingtalk_log', 'dingtalk_robot', 'ai']);
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

@Controller('integrations')
export class IntegrationsController {
  public constructor(private readonly integrations: IntegrationsService) {}

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
    const job = await this.integrations.test(id);
    return apiResponse(
      { operationId: job.id, status: job.status, statusUrl: `/api/v1/operations/${job.id}` },
      request.autoWork.correlationId,
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
