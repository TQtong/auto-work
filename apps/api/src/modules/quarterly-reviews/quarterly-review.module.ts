import { Module } from '@nestjs/common';
import { QuarterlyReviewController } from './quarterly-review.controller.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';
import { QuarterlyCollectionHandler } from './quarterly-collection.handler.js';
import { QuarterlyCollectionService } from './quarterly-collection.service.js';
import { AchievementController } from './achievement.controller.js';
import { QuarterlyAchievementService } from './quarterly-achievement.service.js';
import { QuarterlyCompletenessService } from './quarterly-completeness.service.js';
import { AiModule } from '../ai/ai.module.js';
import { QuarterlyNarrativeConfirmationService } from './quarterly-narrative-confirmation.service.js';
import { QuarterlyReviewAiService } from './quarterly-review-ai.service.js';
import { QuarterlyExportDocxService } from './quarterly-export-docx.service.js';
import { QuarterlyExportHandler } from './quarterly-export.handler.js';
import { QuarterlyExportService } from './quarterly-export.service.js';
import { QuarterlyAutomaticDraftService } from './quarterly-automatic-draft.service.js';
import { QuarterlyExportXlsxService } from './quarterly-export-xlsx.service.js';

@Module({
  imports: [AiModule],
  controllers: [QuarterlyReviewController, AchievementController],
  providers: [
    QuarterlyReviewService,
    QuarterlyCollectionService,
    QuarterlyCollectionHandler,
    QuarterlyAchievementService,
    QuarterlyCompletenessService,
    QuarterlyNarrativeConfirmationService,
    QuarterlyReviewAiService,
    QuarterlyExportXlsxService,
    QuarterlyExportDocxService,
    QuarterlyExportService,
    QuarterlyExportHandler,
    QuarterlyAutomaticDraftService,
  ],
  exports: [
    QuarterlyReviewService,
    QuarterlyCollectionService,
    QuarterlyAchievementService,
    QuarterlyCompletenessService,
    QuarterlyNarrativeConfirmationService,
    QuarterlyReviewAiService,
    QuarterlyExportService,
  ],
})
export class QuarterlyReviewModule {}
