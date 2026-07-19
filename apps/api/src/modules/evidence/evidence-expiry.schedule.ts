import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EvidenceLifecycleService } from './evidence-lifecycle.service.js';

@Injectable()
export class EvidenceExpirySchedule {
  private readonly logger = new Logger(EvidenceExpirySchedule.name);

  public constructor(private readonly lifecycle: EvidenceLifecycleService) {}

  @Interval(15 * 60 * 1_000)
  public async expireDueLinks(): Promise<void> {
    try {
      const expired = await this.lifecycle.expireDueLinks();
      if (expired > 0) this.logger.log(`已过期 ${expired} 条证据关系`);
    } catch (error) {
      this.logger.error(
        `证据关系过期调度失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }
}
