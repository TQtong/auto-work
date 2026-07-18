import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { WorkCalendarController } from './work-calendar.controller.js';
import { WorkCalendarService } from './work-calendar.service.js';

@Module({
  controllers: [ProfileController, WorkCalendarController],
  providers: [ProfileService, WorkCalendarService],
  exports: [WorkCalendarService],
})
export class SettingsModule {}
