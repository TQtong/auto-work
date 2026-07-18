import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportService } from './weekly-report.service.js';
import { WeeklyReportAttachmentService } from './weekly-report-attachment.service.js';
import { WeeklyReportAiService } from './weekly-report-ai.service.js';

@Module({
  imports: [AiModule],
  controllers: [WeeklyReportController],
  providers: [WeeklyReportService, WeeklyReportAttachmentService, WeeklyReportAiService],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule {}
