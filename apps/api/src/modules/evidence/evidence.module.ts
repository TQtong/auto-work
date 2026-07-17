import { Module } from '@nestjs/common';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceExpirySchedule } from './evidence-expiry.schedule.js';
import { EvidenceLifecycleService } from './evidence-lifecycle.service.js';
import { EvidenceMaterializerService } from './evidence-materializer.service.js';

@Module({
  controllers: [EvidenceController],
  providers: [EvidenceMaterializerService, EvidenceLifecycleService, EvidenceExpirySchedule],
  exports: [EvidenceMaterializerService, EvidenceLifecycleService],
})
export class EvidenceModule {}
