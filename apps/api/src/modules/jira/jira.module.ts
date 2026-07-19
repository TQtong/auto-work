import { Module } from '@nestjs/common';
import { JiraApiClient } from './jira-api.client.js';
import { JiraController } from './jira.controller.js';
import { JiraMappingService } from './jira-mapping.service.js';
import { JiraProbeService } from './jira-probe.service.js';
import { JiraSyncHandler } from './jira-sync.handler.js';
import { JiraSyncService } from './jira-sync.service.js';
import { JiraSyncSchedule } from './jira-sync.schedule.js';
import { TasksController } from './tasks.controller.js';
import { TaskOverrideExpirySchedule } from './task-override-expiry.schedule.js';
import { TaskOverrideService } from './task-override.service.js';

@Module({
  controllers: [JiraController, TasksController],
  providers: [
    JiraApiClient,
    JiraProbeService,
    JiraMappingService,
    JiraSyncService,
    JiraSyncHandler,
    JiraSyncSchedule,
    TaskOverrideService,
    TaskOverrideExpirySchedule,
  ],
  exports: [JiraApiClient, JiraSyncService],
})
export class JiraModule {}
