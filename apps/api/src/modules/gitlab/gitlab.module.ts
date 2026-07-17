import { Module } from '@nestjs/common';
import { GitLabApiClient } from './gitlab-api.client.js';
import { GitLabController } from './gitlab.controller.js';
import { GitLabProbeService } from './gitlab-probe.service.js';
import { GitLabSyncHandler } from './gitlab-sync.handler.js';
import { GitLabSyncService } from './gitlab-sync.service.js';
import { GitLabSyncSchedule } from './gitlab-sync.schedule.js';
import { GitLabReadService } from './gitlab-read.service.js';

@Module({
  controllers: [GitLabController],
  providers: [
    GitLabApiClient,
    GitLabProbeService,
    GitLabSyncService,
    GitLabSyncHandler,
    GitLabSyncSchedule,
    GitLabReadService,
  ],
  exports: [GitLabApiClient, GitLabSyncService],
})
export class GitLabModule {}
