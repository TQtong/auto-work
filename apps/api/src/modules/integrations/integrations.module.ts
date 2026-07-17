import { Global, Module } from '@nestjs/common';
import { IntegrationProbeRegistry } from './integration-probe.registry.js';
import { IntegrationTestHandler } from './integration-test.handler.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';

@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, IntegrationProbeRegistry, IntegrationTestHandler],
  exports: [IntegrationsService, IntegrationProbeRegistry],
})
export class IntegrationsModule {}
