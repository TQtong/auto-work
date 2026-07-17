import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller.js';
import { BackupHandlers } from './backup.handlers.js';
import { BackupScheduleService } from './backup-schedule.service.js';

@Module({
  controllers: [BackupController],
  providers: [BackupHandlers, BackupScheduleService],
})
export class BackupModule {}
