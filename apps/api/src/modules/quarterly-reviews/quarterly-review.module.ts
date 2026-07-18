import { Module } from '@nestjs/common';
import { QuarterlyReviewController } from './quarterly-review.controller.js';
import { QuarterlyReviewService } from './quarterly-review.service.js';

@Module({
  controllers: [QuarterlyReviewController],
  providers: [QuarterlyReviewService],
  exports: [QuarterlyReviewService],
})
export class QuarterlyReviewModule {}
