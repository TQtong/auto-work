import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import {
  generateWeeklyReportSchema,
  listWeeklyReportsQuerySchema,
} from './weekly-report.schemas.js';
import { WeeklyReportService } from './weekly-report.service.js';

@Controller('weekly-reports')
export class WeeklyReportController {
  public constructor(private readonly reports: WeeklyReportService) {}

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
}
