import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import { WorkCalendarService } from './work-calendar.service.js';
import { createWorkCalendarVersionSchema } from './work-calendar.schemas.js';

@Controller('settings/work-calendar')
export class WorkCalendarController {
  public constructor(private readonly calendars: WorkCalendarService) {}

  @Get()
  public async get(@Req() request: FastifyRequest) {
    return apiResponse(await this.calendars.get(), request.autoWork.correlationId);
  }

  @Post('versions')
  @HttpCode(201)
  public async createVersion(@Body() rawBody: unknown, @Req() request: FastifyRequest) {
    const input = createWorkCalendarVersionSchema.parse(rawBody);
    return apiResponse(
      await this.calendars.createVersion(input, {
        correlationId: request.autoWork.correlationId,
        sessionId: request.autoWork.sessionId,
      }),
      request.autoWork.correlationId,
    );
  }
}
