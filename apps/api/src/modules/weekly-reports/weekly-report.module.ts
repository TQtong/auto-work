import { Module } from '@nestjs/common';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportService } from './weekly-report.service.js';
import { WeeklyReportAttachmentService } from './weekly-report-attachment.service.js';

@Module({
  controllers: [WeeklyReportController],
  providers: [WeeklyReportService, WeeklyReportAttachmentService],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule {}
