import { Module } from '@nestjs/common';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportService } from './weekly-report.service.js';

@Module({
  controllers: [WeeklyReportController],
  providers: [WeeklyReportService],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule {}
