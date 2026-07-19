import { Body, Controller, Param, Post, Put, Req } from '@nestjs/common';
import { apiResponse } from '@auto-work/contracts';
import type { FastifyRequest } from 'fastify';
import {
  addAchievementEvidenceSchema,
  updateAchievementMetricsSchema,
  updateAchievementSchema,
} from './quarterly-review.schemas.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';

/**
 * 单项成果使用独立顶层资源，避免把成果 ID 误当作季度评审 ID。
 * 所有写操作同时校验评审聚合版本和成果版本，浏览器多标签页不能静默覆盖。
 */
@Controller('achievements')
export class AchievementController {
  public constructor(private readonly achievements: QuarterlyAchievementService) {}

  @Put(':id')
  public async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.achievements.update(
        id,
        updateAchievementSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Post(':id/evidence')
  public async addEvidence(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.achievements.addEvidence(
        id,
        addAchievementEvidenceSchema.parse(body),
        this.context(request),
      ),
      request.autoWork.correlationId,
    );
  }

  @Put(':id/metrics')
  public async updateMetrics(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return apiResponse(
      await this.achievements.updateMetrics(
        id,
        updateAchievementMetricsSchema.parse(body),
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
