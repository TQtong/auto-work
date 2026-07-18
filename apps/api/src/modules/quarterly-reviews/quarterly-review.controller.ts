import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import {
  bindMetricTemplateSchema,
  collectQuarterlyReviewSchema,
  confirmQuarterlyReviewSchema,
  createManualNarrativeSchema,
  createManualAchievementSchema,
  createMetricTemplateSchema,
  createQuarterlyReviewSchema,
  createRuleNarrativeSchema,
  decideQuarterlyAiSchema,
  generateQuarterlyAiSchema,
  listAchievementsSchema,
  listQuarterlyCollectionSnapshotsSchema,
  listQuarterlyReviewsSchema,
  updateAchievementSelectionSchema,
  updateScoreItemsSchema,
  restoreNarrativeSchema,
} from './quarterly-review.schemas.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';
import { QuarterlyNarrativeConfirmationService } from './quarterly-narrative-confirmation.service.js';
import { QuarterlyReviewAiService } from './quarterly-review-ai.service.js';

@Controller('quarterly-reviews')
export class QuarterlyReviewController {
  public constructor(
    private readonly reviews: QuarterlyReviewService,
    private readonly collection: QuarterlyCollectionService,
    private readonly achievements: QuarterlyAchievementService,
    private readonly narratives: QuarterlyNarrativeConfirmationService,
    private readonly ai: QuarterlyReviewAiService,
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

  @Get(':id/narratives')
  public async listNarratives(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.narratives.listNarratives(id), request.autoWork.correlationId);
  }

  @Get(':id/narratives/:versionId')
  public async getNarrative(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.getNarrative(id, versionId),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/narratives/rule')
  public async createRuleNarrative(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.createRuleNarrative(
        id,
        createRuleNarrativeSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/narratives/manual')
  public async createManualNarrative(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.createManualNarrative(
        id,
        createManualNarrativeSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/narratives/:versionId/restore')
  public async restoreNarrative(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.restoreNarrative(
        id,
        versionId,
        restoreNarrativeSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/ai/score-suggestion')
  public async generateScoreSuggestion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.ai.generate(
        id,
        'score_suggestion',
        generateQuarterlyAiSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/ai/narrative')
  public async generateAiNarrative(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.ai.generate(
        id,
        'quarterly_review',
        generateQuarterlyAiSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/ai-generations')
  public async listAiGenerations(
    @Param('id') id: string,
    @Query('purpose') purpose: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(await this.ai.list(id, purpose), request.autoWork.correlationId);
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
  public async adoptAiNarrative(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.adoptAiNarrative(
        id,
        generationId,
        decideQuarterlyAiSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/ai-generations/:generationId/reject')
  public async rejectAiSuggestion(
    @Param('id') id: string,
    @Param('generationId') generationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = decideQuarterlyAiSchema.parse(body);
    return apiResponse(
      await this.narratives.rejectAi(id, generationId, input, this.context(request)),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/confirmation-preflight')
  public async confirmationPreflight(
    @Param('id') id: string,
    @Query('narrativeVersionId') narrativeVersionId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.preflight(id, narrativeVersionId),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/confirmations')
  public async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.confirm(
        id,
        confirmQuarterlyReviewSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Get(':id/confirmations')
  public async listConfirmations(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.narratives.listConfirmations(id), request.autoWork.correlationId);
  }

  @Get(':id/confirmations/:confirmationId')
  public async getConfirmation(
    @Param('id') id: string,
    @Param('confirmationId') confirmationId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.narratives.getConfirmation(id, confirmationId),
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
