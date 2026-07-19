import { Global, Module } from '@nestjs/common';
import { GitProcessService } from './git-process.service.js';
import { GitHealthService } from './git-health.service.js';

@Global()
@Module({
  providers: [GitProcessService, GitHealthService],
  exports: [GitProcessService, GitHealthService],
})
export class GitModule {}
