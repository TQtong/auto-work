import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { mkdirSync } from 'node:fs';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ datasources: { db: { url: config.databaseUrl } } });
    // 新机器首次启动时数据目录可能尚不存在；连接前创建目录，避免 SQLite 报“无法打开数据库”。
    mkdirSync(config.dataDir, { recursive: true });
  }

  public async onModuleInit(): Promise<void> {
    await this.$connect();
    // SQLite 的可靠性参数必须由每个连接显式启用，不能只依赖建库时的默认值。
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await this.$queryRawUnsafe('PRAGMA foreign_keys = ON');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await this.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  public async readiness(): Promise<{ ready: boolean; quickCheck: string }> {
    const rows =
      await this.$queryRawUnsafe<Array<{ quick_check: string }>>('PRAGMA quick_check(1)');
    const quickCheck = rows[0]?.quick_check ?? 'unknown';
    return { ready: quickCheck === 'ok', quickCheck };
  }
}
