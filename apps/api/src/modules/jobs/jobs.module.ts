import { Global, Module } from '@nestjs/common';
import { InstanceLeaseService } from './instance-lease.service.js';
import { JobQueueService } from './job-queue.service.js';
import { JobRegistryService } from './job-registry.service.js';
import { JobRunnerService } from './job-runner.service.js';
import { OperationsController } from './operations.controller.js';

@Global()
@Module({
  controllers: [OperationsController],
  providers: [InstanceLeaseService, JobQueueService, JobRegistryService, JobRunnerService],
  exports: [InstanceLeaseService, JobQueueService, JobRegistryService],
})
export class JobsModule {}
