import { Module } from '@nestjs/common';
import { AiProbeService } from './ai-probe.service.js';
import { AiProviderClient } from './ai-provider.client.js';

@Module({
  providers: [AiProviderClient, AiProbeService],
  exports: [AiProviderClient],
})
export class AiModule {}
