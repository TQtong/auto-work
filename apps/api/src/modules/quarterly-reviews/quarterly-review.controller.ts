import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { apiResponse, DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
  queueQuarterlyExportSchema,
} from './quarterly-review.schemas.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';
import { QuarterlyNarrativeConfirmationService } from './quarterly-narrative-confirmation.service.js';
import { QuarterlyReviewAiService } from './quarterly-review-ai.service.js';
import { QuarterlyExportService } from './quarterly-export.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { SessionService } from '../session/session.service.js';

@Controller('quarterly-reviews')
export class QuarterlyReviewController {
  public constructor(
    private readonly reviews: QuarterlyReviewService,
    private readonly collection: QuarterlyCollectionService,
    private readonly achievements: QuarterlyAchievementService,
    private readonly narratives: QuarterlyNarrativeConfirmationService,
    private readonly ai: QuarterlyReviewAiService,
    private readonly exports: QuarterlyExportService,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionService,
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

  @Post(':id/exports')
  @HttpCode(202)
  public async queueExport(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = queueQuarterlyExportSchema.parse(body);
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        '季度绩效导出必须提供格式有效的 Idempotency-Key',
        { httpStatus: 422 },
      );
    }
    const started = await this.idempotency.start({
      actorId: this.sessions.currentProfileId,
      route: `/api/v1/quarterly-reviews/${id}/exports`,
      key,
      requestHash: requestHash({ reviewId: id, ...input }),
    });
    if (started.kind === 'replay') {
      return apiResponse(started.response, request.autoWork.correlationId);
    }
    if (started.kind === 'processing') {
      throw new DomainError('IDEMPOTENCY_REQUEST_PROCESSING', '相同季度导出请求正在处理中', {
        httpStatus: 409,
        retryable: true,
      });
    }
    try {
      const result = await this.exports.queue(id, input, this.context(request));
      await this.idempotency.complete(started.recordId, 202, result);
      return apiResponse(result, request.autoWork.correlationId);
    } catch (error) {
      await this.idempotency.fail(
        started.recordId,
        error instanceof DomainError ? error.code : 'QUARTERLY_EXPORT_QUEUE_FAILED',
      );
      throw error;
    }
  }

  @Get(':id/exports')
  public async listExports(@Param('id') id: string, @Req() request: FastifyRequest) {
    return apiResponse(await this.exports.list(id), request.autoWork.correlationId, {
      asOf: new Date().toISOString(),
    });
  }

  @Get(':id/exports/:artifactId')
  public async getExport(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(await this.exports.get(id, artifactId), request.autoWork.correlationId);
  }

  @Get(':id/exports/:artifactId/download')
  public async downloadExport(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.exports.download(id, artifactId, this.context(request));
    const asciiName = file.fileName.replace(/[^A-Za-z0-9._-]/gu, '_');
    reply.type(file.mimeType);
    reply.header('Content-Length', String(file.buffer.length));
    reply.header(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(file.buffer);
  }

  private context(request: FastifyRequest) {
    return {
      correlationId: request.autoWork.correlationId,
      sessionId: request.autoWork.sessionId,
    };
  }
}
