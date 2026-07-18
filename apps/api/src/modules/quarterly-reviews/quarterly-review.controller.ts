import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import {
  bindMetricTemplateSchema,
  createMetricTemplateSchema,
  createQuarterlyReviewSchema,
  listQuarterlyReviewsSchema,
  updateScoreItemsSchema,
} from './quarterly-review.schemas.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';

@Controller('quarterly-reviews')
export class QuarterlyReviewController {
  public constructor(private readonly reviews: QuarterlyReviewService) {}

  @Get('metric-templates')
  public async metricTemplates(@Req() request: FastifyRequest) {
    return apiResponse(await this.reviews.listMetricTemplates(), request.autoWork.correlationId);
  }

  @Post('metric-templates')
  public async createMetricTemplate(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = createMetricTemplateSchema.parse(body);
    return apiResponse(
      await this.reviews.createMetricTemplate(input, this.context(request)),
      request.autoWork.correlationId,
    );
  }

  @Get()
  public async list(@Query() query: Record<string, unknown>, @Req() request: FastifyRequest) {
    return apiResponse(
      await this.reviews.list(listQuarterlyReviewsSchema.parse(query)),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Post()
  public async create(@Body() body: unknown, @Req() request: FastifyRequest) {
    return apiResponse(
      await this.reviews.create(createQuarterlyReviewSchema.parse(body), this.context(request)),
      request.autoWork.correlationId,
    );
  }

  @Get(':id')
  public async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.reviews.get(id), request.autoWork.correlationId);
  }

  @Put(':id/metric-template')
  public async bindMetricTemplate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.reviews.bindMetricTemplate(
        id,
        bindMetricTemplateSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Put(':id/scores')
  public async updateScores(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.reviews.updateScores(
        id,
        updateScoreItemsSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  private context(request: FastifyRequest) {
    return {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    };
  }
}
