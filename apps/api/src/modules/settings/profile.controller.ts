import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProfileService } from './profile.service.js';

const updateProfileSchema = z
  .object({
    version: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(100).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    workdayHours: z.number().int().min(1).max(24).optional(),
  })
  .strict();

const addAliasSchema = z
  .object({
    aliasType: z.enum([
      'git_name',
      'git_email',
      'gitlab_user_id',
      'gitlab_username',
      'jira_account_id',
      'jira_username',
    ]),
    value: z.string().trim().min(1).max(320),
    source: z.enum(['user', 'git_config', 'gitlab_connection', 'jira_connection']).default('user'),
    enabled: z.boolean().default(false),
  })
  .strict();

const aliasStateSchema = z.object({ enabled: z.boolean() }).strict();

@Controller('settings/profile')
export class ProfileController {
  public constructor(private readonly profiles: ProfileService) {}

  @Get()
  public async get(@Req() request: FastifyRequest) {
    return apiResponse(await this.profiles.get(), request.autoWork.correlationId);
  }

  @Put()
  public async update(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const body = updateProfileSchema.parse(rawBody);
    const profile = await this.profiles.update(body, {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    });
    return apiResponse(profile, request.autoWork.correlationId);
  }

  @Post('aliases')
  public async addAlias(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const body = addAliasSchema.parse(rawBody);
    const alias = await this.profiles.addAlias(body, {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    });
    return apiResponse(alias, request.autoWork.correlationId);
  }

  @Put('aliases/:id/state')
  public async setAliasState(
    @Param('id') id: string,
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
  ) {
    const body = aliasStateSchema.parse(rawBody);
    const alias = await this.profiles.setAliasEnabled(id, body.enabled, {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    });
    return apiResponse(alias, request.autoWork.correlationId);
  }
}
