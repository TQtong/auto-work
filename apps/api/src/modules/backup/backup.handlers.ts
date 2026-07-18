import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { newId } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { DiagnosticsService } from '../diagnostics/diagnostics.service.js';

@Injectable()
export class BackupHandlers implements OnModuleInit {
  private readonly backupDirectory: string;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistryService,
    private readonly diagnostics: DiagnosticsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.backupDirectory = join(config.dataDir, 'backups');
  }

  public onModuleInit(): void {
    this.registry.register(this.createHandler());
    this.registry.register(this.verifyHandler());
  }

  private createHandler(): JobHandler {
    return {
      type: 'backup.create',
      concurrency: 1,
      recovery: 'safe_replay',
      execute: async (context) => this.createBackup(context),
    };
  }

  private verifyHandler(): JobHandler {
    return {
      type: 'backup.verify',
      concurrency: 1,
      recovery: 'safe_replay',
      execute: async (context) => this.verifyBackup(context),
    };
  }

  private async createBackup(context: JobExecutionContext): Promise<unknown> {
    await this.diagnostics.assertGrowthAllowed('backup.create');
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const artifactId = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `auto-work-${timestamp}-${artifactId.slice(0, 8)}.db`;
    const finalPath = join(this.backupDirectory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    await this.prisma.backupArtifact.create({ data: { id: artifactId, status: 'running' } });
    try {
      await context.reportProgress(10);
      // VACUUM INTO 使用 SQLite 自身一致性快照，避免直接复制活动 db/wal 组合。
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${this.escapeSqlitePath(temporaryPath)}'`);
      await context.reportProgress(65);
      const [sha256, fileStat] = await Promise.all([
        this.hashFile(temporaryPath),
        stat(temporaryPath),
      ]);
      await rename(temporaryPath, finalPath);
      await this.prisma.backupArtifact.update({
        where: { id: artifactId },
        data: {
          fileName,
          path: finalPath,
          sha256,
          sizeBytes: BigInt(fileStat.size),
          status: 'succeeded',
        },
      });
      await context.reportProgress(100);
      return { artifactId, fileName, sha256, sizeBytes: fileStat.size };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      await this.prisma.backupArtifact.update({
        where: { id: artifactId },
        data: { status: 'failed', errorCode: 'BACKUP_CREATE_FAILED' },
      });
      throw error;
    }
  }

  private async verifyBackup(context: JobExecutionContext): Promise<unknown> {
    if (!context.payloadRef) throw new Error('校验作业缺少备份 ID');
    const artifact = await this.prisma.backupArtifact.findUniqueOrThrow({
      where: { id: context.payloadRef },
    });
    if (!artifact.path || !artifact.sha256) throw new Error('备份文件尚未成功生成');
    await context.reportProgress(15);
    const actualHash = await this.hashFile(artifact.path);
    if (actualHash !== artifact.sha256) {
      await this.prisma.backupArtifact.update({
        where: { id: artifact.id },
        data: { status: 'verification_failed', errorCode: 'BACKUP_HASH_MISMATCH' },
      });
      throw new Error('备份文件哈希不一致');
    }
    await context.reportProgress(60);
    const isolated = new PrismaClient({
      datasources: { db: { url: `file:${artifact.path.replaceAll('\\', '/')}` } },
    });
    try {
      const rows =
        await isolated.$queryRawUnsafe<Array<{ quick_check: string }>>('PRAGMA quick_check');
      const quickCheck = rows[0]?.quick_check ?? 'unknown';
      if (quickCheck !== 'ok') throw new Error(`备份数据库完整性检查失败：${quickCheck}`);
      await this.prisma.backupArtifact.update({
        where: { id: artifact.id },
        data: { status: 'verified', verifiedAt: new Date(), errorCode: null },
      });
      await context.reportProgress(100);
      return { artifactId: artifact.id, sha256: actualHash, quickCheck };
    } finally {
      await isolated.$disconnect();
    }
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  private escapeSqlitePath(path: string): string {
    return path.replaceAll('\\', '/').replaceAll("'", "''");
  }
}
