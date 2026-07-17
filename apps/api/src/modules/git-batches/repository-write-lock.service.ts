import { Injectable } from '@nestjs/common';

/** 单实例 Worker 内按仓库串行化写动作；应用本身还由全局实例租约保证只有一个活跃执行器。 */
@Injectable()
export class RepositoryWriteLockService {
  private readonly tails = new Map<string, Promise<void>>();

  public async acquire(repositoryId: string): Promise<() => void> {
    const previous = this.tails.get(repositoryId) ?? Promise.resolve();
    let releasePromise!: () => void;
    const current = new Promise<void>((resolve) => {
      releasePromise = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(repositoryId, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releasePromise();
      void tail.finally(() => {
        if (this.tails.get(repositoryId) === tail) this.tails.delete(repositoryId);
      });
    };
  }
}
