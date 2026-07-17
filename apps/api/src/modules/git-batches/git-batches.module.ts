import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module.js';
import { GitBatchEngineService } from './git-batch-engine.service.js';
import { GitBatchHandlers } from './git-batch.handlers.js';
import { GitBatchService } from './git-batch.service.js';
import { GitBatchesController } from './git-batches.controller.js';
import { RepositoryWriteLockService } from './repository-write-lock.service.js';

@Module({
  imports: [RepositoriesModule],
  controllers: [GitBatchesController],
  providers: [GitBatchService, GitBatchEngineService, GitBatchHandlers, RepositoryWriteLockService],
})
export class GitBatchesModule {}
