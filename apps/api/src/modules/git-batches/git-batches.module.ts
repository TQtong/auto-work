import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module.js';
import { GitBranchesController } from './git-branches.controller.js';
import { GitBranchesService } from './git-branches.service.js';
import { RepositoryWriteLockService } from './repository-write-lock.service.js';

@Module({
  imports: [RepositoriesModule],
  controllers: [GitBranchesController],
  providers: [GitBranchesService, RepositoryWriteLockService],
})
export class GitBranchesModule {}
