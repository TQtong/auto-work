import { Global, Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { RetentionService } from './retention.service.js';

@Global()
@Module({
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService, RetentionService],
  exports: [DiagnosticsService],
})
export class DiagnosticsModule {}
