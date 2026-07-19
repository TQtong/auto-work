import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { TaskOverrideService } from './task-override.service.js';

@Injectable()
export class TaskOverrideExpirySchedule {
  public constructor(private readonly overrides: TaskOverrideService) {}

  /** 有效期是业务规则而不是页面提示；后台定期恢复来源事实并在同一事务写入审计。 */
  @Interval(60_000)
  public async expireDueOverrides(): Promise<void> {
    await this.overrides.expireDue();
  }
}
