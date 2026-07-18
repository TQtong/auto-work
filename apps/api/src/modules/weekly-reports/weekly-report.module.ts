import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DingTalkModule } from '../dingtalk/dingtalk.module.js';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportService } from './weekly-report.service.js';
import { WeeklyReportAttachmentService } from './weekly-report-attachment.service.js';
import { WeeklyReportAiService } from './weekly-report-ai.service.js';
import { WeeklyReportDeliveryHandler } from './weekly-report-delivery.handler.js';
import { WeeklyReportDeliveryRecoveryService } from './weekly-report-delivery-recovery.service.js';
import { WeeklyReportDeliveryService } from './weekly-report-delivery.service.js';
import { WeeklyReportNotificationLedgerService } from './weekly-report-notification-ledger.service.js';

@Module({
  imports: [AiModule, DingTalkModule],
  controllers: [WeeklyReportController],
  providers: [
    WeeklyReportService,
    WeeklyReportAttachmentService,
    WeeklyReportAiService,
    WeeklyReportDeliveryService,
    WeeklyReportDeliveryRecoveryService,
    WeeklyReportNotificationLedgerService,
    WeeklyReportDeliveryHandler,
  ],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule {}
