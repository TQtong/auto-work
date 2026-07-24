import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { newId } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { JobExecutionContext, JobHandler } from '../jobs/job-registry.service.js';
import { JobRegistryService } from '../jobs/job-registry.service.js';
import { DiagnosticsService } from '../diagnostics/diagnostics.service.js';
import type { PendingRestoreManifest } from '../../infrastructure/database/pending-restore.js';

interface BackupCreationResult {
  artifactId: string;
  fileName: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  schemaChecksum: string;
}

@Injectable()
export class BackupHandlers implements OnModuleInit {
  private readonly backupDirectory: string;
  private readonly pendingRestorePath: string;
  private readonly databasePath: string;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistryService,
    private readonly diagnostics: DiagnosticsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.backupDirectory = join(config.dataDir, 'backups');
    this.pendingRestorePath = join(config.dataDir, 'pending-restore.json');
    // 保留当前平台的原生分隔符；Linux 容器不能把绝对路径强制转换为 Windows 反斜杠。
    this.databasePath = normalize(config.databaseUrl.slice('file:'.length));
  }

  public onModuleInit(): void {
    this.registry.register(this.createHandler());
    this.registry.register(this.verifyHandler());
    this.registry.register(this.restoreHandler());
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

  private restoreHandler(): JobHandler {
    return {
      type: 'backup.restore.prepare',
      concurrency: 1,
      recovery: 'safe_replay',
      execute: async (context) => this.prepareRestore(context),
    };
  }

  private async createBackup(
    context: JobExecutionContext,
    prefix = 'auto-work',
    progress = { start: 10, copied: 65, completed: 100 },
  ): Promise<BackupCreationResult> {
    await this.diagnostics.assertGrowthAllowed('backup.create');
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const artifactId = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${prefix}-${timestamp}-${artifactId.slice(0, 8)}.db`;
    const finalPath = join(this.backupDirectory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    await this.prisma.backupArtifact.create({ data: { id: artifactId, status: 'running' } });
    try {
      const schema = await this.prisma.schemaMetadata.findUnique({ where: { id: 1 } });
      const schemaChecksum = schema?.schemaChecksum ?? 'unknown';
      await context.reportProgress(progress.start);
      // VACUUM INTO 使用 SQLite 自身一致性快照，避免直接复制活动 db/wal 组合。
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${this.escapeSqlitePath(temporaryPath)}'`);
      await context.reportProgress(progress.copied);
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
          schemaChecksum,
        },
      });
      await context.reportProgress(progress.completed);
      return {
        artifactId,
        fileName,
        path: finalPath,
        sha256,
        sizeBytes: fileStat.size,
        schemaChecksum,
      };
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
      const foreignKeys = await isolated.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'PRAGMA foreign_key_check',
      );
      if (foreignKeys.length > 0) throw new Error('备份数据库外键检查失败');
      const schema = await isolated.schemaMetadata.findUnique({ where: { id: 1 } });
      const schemaChecksum = schema?.schemaChecksum ?? 'unknown';
      await this.prisma.backupArtifact.update({
        where: { id: artifact.id },
        data: { status: 'verified', schemaChecksum, verifiedAt: new Date(), errorCode: null },
      });
      await context.reportProgress(100);
      return {
        artifactId: artifact.id,
        sha256: actualHash,
        quickCheck,
        foreignKeyViolations: 0,
        schemaChecksum,
      };
    } finally {
      await isolated.$disconnect();
    }
  }

  public async restorePreflight(artifactId: string) {
    const artifact = await this.prisma.backupArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) return null;
    const currentSchema = await this.prisma.schemaMetadata.findUnique({ where: { id: 1 } });
    const pending = await this.pendingRestore();
    return {
      artifactId,
      fileName: artifact.fileName,
      status: artifact.status,
      sha256: artifact.sha256,
      schemaChecksum: artifact.schemaChecksum,
      currentSchemaChecksum: currentSchema?.schemaChecksum ?? null,
      compatible:
        artifact.status === 'verified' &&
        Boolean(artifact.sha256) &&
        Boolean(artifact.schemaChecksum) &&
        artifact.schemaChecksum === currentSchema?.schemaChecksum,
      pendingRestore: pending,
      confirmationText: artifact.fileName ? `恢复 ${artifact.fileName}` : null,
    };
  }

  public async pendingRestore() {
    try {
      const manifest = JSON.parse(
        await readFile(this.pendingRestorePath, 'utf8'),
      ) as PendingRestoreManifest;
      return {
        restoreId: manifest.restoreId,
        artifactId: manifest.artifactId,
        requestedAt: manifest.requestedAt,
        restartRequired: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  public async cancelPendingRestore() {
    const pending = await this.pendingRestore();
    if (!pending) return null;
    await rm(this.pendingRestorePath, { force: true });
    return pending;
  }

  private async prepareRestore(context: JobExecutionContext) {
    if (!context.payloadRef) throw new Error('恢复准备作业缺少备份 ID');
    const artifact = await this.prisma.backupArtifact.findUniqueOrThrow({
      where: { id: context.payloadRef },
    });
    if (
      artifact.status !== 'verified' ||
      !artifact.path ||
      !artifact.sha256 ||
      !artifact.schemaChecksum
    )
      throw new Error('只有完成哈希、完整性、外键和 schema 校验的备份才能恢复');
    const existing = await this.pendingRestore();
    if (existing) {
      if (existing.artifactId === artifact.id) return { ...existing, replayed: true };
      throw new Error('已有其他待恢复备份，请先重启完成或人工取消恢复清单');
    }
    await context.reportProgress(10);
    if ((await this.hashFile(artifact.path)) !== artifact.sha256)
      throw new Error('恢复前复核发现备份文件哈希不一致');
    const currentSchema = await this.prisma.schemaMetadata.findUnique({ where: { id: 1 } });
    if (currentSchema?.schemaChecksum !== artifact.schemaChecksum)
      throw new Error('备份 schema 与当前应用不兼容，禁止恢复');
    await this.prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    const safety = await this.createBackup(context, 'pre-restore', {
      start: 25,
      copied: 55,
      completed: 75,
    });
    const manifest: PendingRestoreManifest = {
      restoreId: newId(),
      artifactId: artifact.id,
      sourcePath: artifact.path,
      sourceSha256: artifact.sha256,
      targetDatabasePath: this.databasePath,
      schemaChecksum: artifact.schemaChecksum,
      safetyBackupArtifactId: safety.artifactId,
      requestedAt: new Date().toISOString(),
    };
    const temporary = `${this.pendingRestorePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.pendingRestorePath);
    await context.reportProgress(100);
    return {
      restoreId: manifest.restoreId,
      artifactId: artifact.id,
      safetyBackupArtifactId: safety.artifactId,
      restartRequired: true,
      replayed: false,
    };
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
