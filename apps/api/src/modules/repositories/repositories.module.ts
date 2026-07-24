import { Module } from '@nestjs/common';
import { RepositoriesController } from './repositories.controller.js';
import { RepositoryInspectorService } from './repository-inspector.service.js';
import {
  executeWindowsDirectoryPicker,
  REPOSITORY_DIRECTORY_PICKER_EXECUTOR,
  REPOSITORY_DIRECTORY_PICKER_PLATFORM,
  RepositoryDirectoryPickerService,
} from './repository-directory-picker.service.js';
import { RepositoryJobHandlers } from './repository-job.handlers.js';
import { RepositoryService } from './repository.service.js';
import { RepositorySyncSchedule } from './repository-sync.schedule.js';

@Module({
  controllers: [RepositoriesController],
  providers: [
    {
      provide: REPOSITORY_DIRECTORY_PICKER_EXECUTOR,
      useValue: executeWindowsDirectoryPicker,
    },
    { provide: REPOSITORY_DIRECTORY_PICKER_PLATFORM, useValue: process.platform },
    RepositoryDirectoryPickerService,
    RepositoryInspectorService,
    RepositoryService,
    RepositoryJobHandlers,
    RepositorySyncSchedule,
  ],
  exports: [RepositoryInspectorService, RepositoryService],
})
export class RepositoriesModule {}
