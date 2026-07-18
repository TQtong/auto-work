import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import {
  bindMetricTemplateSchema,
  collectQuarterlyReviewSchema,
  createManualAchievementSchema,
  createMetricTemplateSchema,
  createQuarterlyReviewSchema,
  listAchievementsSchema,
  listQuarterlyCollectionSnapshotsSchema,
  listQuarterlyReviewsSchema,
  updateAchievementSelectionSchema,
  updateScoreItemsSchema,
} from './quarterly-review.schemas.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';

@Controller('quarterly-reviews')
export class QuarterlyReviewController {
  public constructor(
    private readonly reviews: QuarterlyReviewService,
    private readonly collection: QuarterlyCollectionService,
    private readonly achievements: QuarterlyAchievementService,
  ) {}

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

  @Post(':id/collect')
  @HttpCode(202)
  public async collect(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.collection.queue(
        id,
        collectQuarterlyReviewSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/collection-snapshots')
  public async collectionSnapshots(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.collection.listSnapshots(
        id,
        listQuarterlyCollectionSnapshotsSchema.parse(query).limit,
      ),
      request.autoWork.correlationId,
      { asOf: new Date().toISOString() },
    );
  }

  @Get(':id/collection-snapshots/:snapshotId')
  public async collectionSnapshot(
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.collection.getSnapshot(id, snapshotId),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/achievements')
  public async listAchievements(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.achievements.list(id, listAchievementsSchema.parse(query));
    return {
      ...apiResponse(result.items, request.autoWork.correlationId, {
        asOf: new Date().toISOString(),
      }),
      page: result.page,
    };
  }

  @Post(':id/achievements')
  public async createAchievement(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.achievements.createManual(
        id,
        createManualAchievementSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Put(':id/achievements')
  public async updateAchievementSelection(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.achievements.updateSelection(
        id,
        updateAchievementSelectionSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
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
