import { Module } from '@nestjs/common';
import { RepositoriesController } from './repositories.controller.js';
import { RepositoryInspectorService } from './repository-inspector.service.js';
import { RepositoryJobHandlers } from './repository-job.handlers.js';
import { RepositoryService } from './repository.service.js';

@Module({
  controllers: [RepositoriesController],
  providers: [RepositoryInspectorService, RepositoryService, RepositoryJobHandlers],
  exports: [RepositoryInspectorService, RepositoryService],
})
export class RepositoriesModule {}
