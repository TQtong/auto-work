import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobQueueService } from '../jobs/job-queue.service.js';

@Injectable()
export class BackupScheduleService {
  public constructor(private readonly queue: JobQueueService) {}

  @Cron('0 0 2 * * *', { timeZone: 'Asia/Shanghai' })
  public async scheduleDailyBackup(): Promise<void> {
    const businessDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await this.queue.enqueue({
      type: 'backup.create',
      payloadSummary: { trigger: 'scheduled', businessDate },
      priority: 200,
      maxAttempts: 3,
      dedupeKey: `backup.daily:${businessDate}`,
    });
  }
}
