import { Module } from '@nestjs/common';
import { EvidenceMaterializerService } from './evidence-materializer.service.js';

@Module({
  providers: [EvidenceMaterializerService],
  exports: [EvidenceMaterializerService],
})
export class EvidenceModule {}
