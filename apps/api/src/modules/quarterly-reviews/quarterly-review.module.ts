import { Module } from '@nestjs/common';
import { QuarterlyReviewController } from './quarterly-review.controller.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';
import { QuarterlyCollectionHandler } from './quarterly-collection.handler.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { AchievementController } from './achievement.controller.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCompletenessService } from './quarterly-completeness.service.js';

@Module({
  controllers: [QuarterlyReviewController, AchievementController],
  providers: [
    QuarterlyReviewService,
    QuarterlyCollectionService,
    QuarterlyCollectionHandler,
    QuarterlyAchievementService,
    QuarterlyCompletenessService,
  ],
  exports: [
    QuarterlyReviewService,
    QuarterlyCollectionService,
    QuarterlyAchievementService,
    QuarterlyCompletenessService,
  ],
})
export class QuarterlyReviewModule {}
