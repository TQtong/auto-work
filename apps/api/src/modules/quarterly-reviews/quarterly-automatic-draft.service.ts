import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { aiProviderConfigSchema } from '../ai/ai-provider.config.js';
import { SessionService } from '../session/session.service.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { QuarterlyNarrativeConfirmationService } from './quarterly-narrative-confirmation.service.js';
import { QuarterlyReviewAiService } from './quarterly-review-ai.service.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';

@Injectable()
export class QuarterlyAutomaticDraftService {
  private readonly logger = new Logger(QuarterlyAutomaticDraftService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly reviews: QuarterlyReviewService,
    private readonly collection: QuarterlyCollectionService,
    private readonly achievements: QuarterlyAchievementService,
    private readonly ai: QuarterlyReviewAiService,
    private readonly narratives: QuarterlyNarrativeConfirmationService,
  ) {}

  @Cron('0 */20 * * * *', { timeZone: 'Asia/Shanghai' })
  public async generateCurrentQuarter(): Promise<void> {
    await this.generateForCurrentQuarter().catch((error) => {
      this.logger.warn(
        `自动绩效草稿生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  public async generateForCurrentQuarter(now = new Date()): Promise<unknown> {
    const taskCount = await this.prisma.task.count({
      where: { isCurrentUser: true, visibilityState: 'visible' },
    });
    if (taskCount === 0) return { skipped: true, reason: 'no_tasks' };

    const { year, quarter } = this.shanghaiQuarter(now);
    const context = {
      correlationId: `automatic-quarterly:${year}-Q${quarter}`,
      sessionId: 'system:automatic-quarterly-draft',
    };
    let review = await this.prisma.quarterlyReview.findFirst({
      where: {
        ownerProfileId: this.sessions.currentProfileId,
        naturalQuarter: true,
        year,
        quarter,
        archivedAt: null,
      },
    });
    if (!review) {
      const created = await this.reviews.create(
        { periodType: 'natural_quarter', year, quarter },
        context,
      );
      review = await this.prisma.quarterlyReview.findUniqueOrThrow({
        where: { id: created.id },
      });
    }

    const weekStart = this.shanghaiWeekStart(now);
    const currentWeekSnapshot = await this.prisma.quarterlyCollectionSnapshot.findFirst({
      where: { reviewId: review.id, createdAt: { gte: weekStart } },
      orderBy: { createdAt: 'desc' },
    });
    if (!currentWeekSnapshot) {
      if (review.status !== 'collecting') {
        await this.collection.queue(
          review.id,
          {
            reviewVersion: review.version,
            sources: { tasks: true, evidence: true, confirmedWeeklyReports: true },
            freshnessPolicy: { mode: 'allow_stale', maximumAgeHours: 24 * 90 },
          },
          context,
        );
      }
      return { queued: review.status !== 'collecting', reviewId: review.id };
    }
    if (review.status === 'collecting') return { skipped: true, reason: 'collection_running' };

    const candidates = await this.prisma.achievement.findMany({
      where: { reviewId: review.id, selectionStatus: 'candidate' },
      orderBy: [{ periodStart: 'asc' }, { createdAt: 'asc' }],
    });
    if (candidates.length > 0) {
      await this.achievements.updateSelection(
        review.id,
        {
          reviewVersion: review.version,
          actions: candidates.map((item, index) => ({
            achievementId: item.id,
            version: item.version,
            status: 'selected',
            reason: '后台按任务日期自动纳入绩效草稿',
            sortOrder: index,
          })),
        },
        context,
      );
      review = await this.prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } });
    }

    const provider = await this.findAiProvider('quarterly_review');
    if (!provider) return { generated: true, ai: false, reviewId: review.id };
    const existingNarrative = await this.prisma.aiGeneration.findFirst({
      where: {
        quarterlyReviewId: review.id,
        purpose: 'quarterly_review',
        baseQuarterlyReviewVersion: review.version,
        status: 'succeeded',
      },
    });
    if (!existingNarrative) {
      const generated = await this.ai.generate(
        review.id,
        'quarterly_review',
        { reviewVersion: review.version, providerConnectionId: provider.id },
        context,
      );
      if (generated.generation.status === 'succeeded') {
        await this.narratives.adoptAiNarrative(
          review.id,
          generated.generation.id,
          {
            reviewVersion: review.version,
            decisionReason: '后台按任务日期自动生成绩效自评草稿',
          },
          context,
        );
        review = await this.prisma.quarterlyReview.findUniqueOrThrow({ where: { id: review.id } });
      }
    }

    if (review.metricTemplateVersionId) {
      const scoreProvider = await this.findAiProvider('score_suggestion');
      const scoreExists = await this.prisma.aiGeneration.findFirst({
        where: {
          quarterlyReviewId: review.id,
          purpose: 'score_suggestion',
          baseQuarterlyReviewVersion: review.version,
          status: 'succeeded',
        },
      });
      if (scoreProvider && !scoreExists) {
        await this.ai.generate(
          review.id,
          'score_suggestion',
          { reviewVersion: review.version, providerConnectionId: scoreProvider.id },
          context,
        );
      }
    }
    return { generated: true, ai: true, reviewId: review.id };
  }

  private async findAiProvider(purpose: 'quarterly_review' | 'score_suggestion') {
    const rows = await this.prisma.integrationConnection.findMany({
      where: {
        type: 'ai',
        enabled: true,
        status: 'healthy',
        credentialRef: { not: null },
      },
      orderBy: { lastSuccessAt: 'desc' },
    });
    return (
      rows.find((row) => {
        const parsed = aiProviderConfigSchema.safeParse(JSON.parse(row.configJson));
        return parsed.success && parsed.data.allowedPurposes.includes(purpose);
      }) ?? null
    );
  }

  private shanghaiQuarter(value: Date): { year: number; quarter: 1 | 2 | 3 | 4 } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(value);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    return { year, quarter: (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4 };
  }

  private shanghaiDayStart(value: Date): Date {
    return new Date(`${this.shanghaiDate(value)}T00:00:00.000+08:00`);
  }

  private shanghaiWeekStart(value: Date): Date {
    const date = this.shanghaiDate(value);
    const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    return new Date(this.shanghaiDayStart(value).getTime() - mondayOffset * 24 * 60 * 60_000);
  }

  private shanghaiDate(value: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }
}
