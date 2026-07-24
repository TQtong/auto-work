import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { QuarterlyAutomaticDraftService } from '../src/modules/quarterly-reviews/quarterly-automatic-draft.service.js';
import type { QuarterlyAchievementService } from '../src/modules/quarterly-reviews/quarterly-achievement.service.js';
import type { QuarterlyCollectionService } from '../src/modules/quarterly-reviews/quarterly-collection.service.js';
import type { QuarterlyNarrativeConfirmationService } from '../src/modules/quarterly-reviews/quarterly-narrative-confirmation.service.js';
import type { QuarterlyReviewAiService } from '../src/modules/quarterly-reviews/quarterly-review-ai.service.js';
import type { QuarterlyReviewService } from '../src/modules/quarterly-reviews/quarterly-review.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('自动季度绩效草稿', () => {
  it('当前季度有任务但本周尚未收集时自动排队完整来源收集', async () => {
    const queue = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const review = {
      id: 'review-1',
      ownerProfileId: 'local-user',
      naturalQuarter: true,
      year: 2026,
      quarter: 3,
      status: 'draft',
      version: 1,
    };
    const service = new QuarterlyAutomaticDraftService(
      {
        task: { count: vi.fn().mockResolvedValue(4) },
        quarterlyReview: { findFirst: vi.fn().mockResolvedValue(review) },
        quarterlyCollectionSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { currentProfileId: 'local-user' } as SessionService,
      {} as QuarterlyReviewService,
      { queue } as unknown as QuarterlyCollectionService,
      {} as QuarterlyAchievementService,
      {} as QuarterlyReviewAiService,
      {} as QuarterlyNarrativeConfirmationService,
    );

    await expect(
      service.generateForCurrentQuarter(new Date('2026-07-20T10:30:00.000Z')),
    ).resolves.toEqual({ queued: true, reviewId: 'review-1' });
    expect(queue).toHaveBeenCalledWith(
      'review-1',
      expect.objectContaining({
        reviewVersion: 1,
        sources: { tasks: true, evidence: true, confirmedWeeklyReports: true },
      }),
      expect.objectContaining({ correlationId: 'automatic-quarterly:2026-Q3' }),
    );
  });

  it('没有个人任务时不创建季度评审', async () => {
    const service = new QuarterlyAutomaticDraftService(
      { task: { count: vi.fn().mockResolvedValue(0) } } as unknown as PrismaService,
      { currentProfileId: 'local-user' } as SessionService,
      {} as QuarterlyReviewService,
      {} as QuarterlyCollectionService,
      {} as QuarterlyAchievementService,
      {} as QuarterlyReviewAiService,
      {} as QuarterlyNarrativeConfirmationService,
    );

    await expect(service.generateForCurrentQuarter()).resolves.toEqual({
      skipped: true,
      reason: 'no_tasks',
    });
  });
});
