import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { GitProcessService } from './git-process.service.js';

@Injectable()
export class GitHealthService implements OnApplicationBootstrap {
  public ready = false;
  public version: string | null = null;
  public reason: string | null = '尚未完成首次健康握手';

  public constructor(private readonly git: GitProcessService) {}

  public async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.git.runRead(process.cwd(), ['--version'], { timeoutMs: 3_000 });
      this.version = result.stdout.toString('utf8').trim();
      this.ready = /^git version /u.test(this.version);
      this.reason = this.ready ? null : 'Git 返回了无法识别的版本信息';
    } catch (error) {
      this.ready = false;
      this.reason = (error as Error).message;
    }
  }
}
