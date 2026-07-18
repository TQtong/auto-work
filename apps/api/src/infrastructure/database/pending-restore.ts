import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../../config/config.module.js';

const restoreManifestSchema = z
  .object({
    restoreId: z.uuid(),
    artifactId: z.uuid(),
    sourcePath: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    targetDatabasePath: z.string().min(1),
    schemaChecksum: z.string().min(1),
    safetyBackupArtifactId: z.uuid(),
    requestedAt: z.string().datetime(),
  })
  .strict();

export type PendingRestoreManifest = z.infer<typeof restoreManifestSchema>;

export interface AppliedRestore {
  restoreId: string;
  artifactId: string;
  emergencyBackupPath: string | null;
  appliedManifestPath: string;
}

/**
 * 恢复必须发生在 Prisma 连接前。这样 SQLite 主库、WAL 和 SHM 都没有打开句柄，
 * Windows 上才能执行可回滚的原子重命名，而不是冒险覆盖正在使用的数据库。
 */
export async function applyPendingRestore(config: AppConfig): Promise<AppliedRestore | null> {
  const manifestPath = join(config.dataDir, 'pending-restore.json');
  try {
    await access(manifestPath);
  } catch {
    return null;
  }
  const manifest = restoreManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const backupRoot = resolve(config.dataDir, 'backups');
  const sourcePath = resolve(manifest.sourcePath);
  const targetPath = resolve(manifest.targetDatabasePath);
  const configuredTarget = resolve(config.databaseUrl.slice('file:'.length));
  if (!sourcePath.startsWith(`${backupRoot}${sep}`) || targetPath !== configuredTarget) {
    throw new Error('待恢复清单包含越界路径，已拒绝启动时恢复');
  }
  if ((await hashFile(sourcePath)) !== manifest.sourceSha256) {
    throw new Error('待恢复备份哈希与清单不一致，当前数据库保持不变');
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const temporaryTarget = `${targetPath}.restore.tmp`;
  await rm(temporaryTarget, { force: true });
  await copyFile(sourcePath, temporaryTarget);
  if ((await hashFile(temporaryTarget)) !== manifest.sourceSha256) {
    await rm(temporaryTarget, { force: true });
    throw new Error('恢复临时副本哈希校验失败，当前数据库保持不变');
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const emergencyPath = join(
    backupRoot,
    `pre-restore-emergency-${timestamp}-${basename(targetPath)}`,
  );
  let originalMoved = false;
  try {
    try {
      await rename(targetPath, emergencyPath);
      originalMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 主库已形成一致安全备份；旧 WAL/SHM 不能与恢复库混用，必须按精确路径移除。
    await Promise.all([
      rm(`${targetPath}-wal`, { force: true }),
      rm(`${targetPath}-shm`, { force: true }),
    ]);
    await rename(temporaryTarget, targetPath);
    const appliedManifestPath = join(
      backupRoot,
      `restore-applied-${timestamp}-${manifest.restoreId}.json`,
    );
    await rename(manifestPath, appliedManifestPath);
    return {
      restoreId: manifest.restoreId,
      artifactId: manifest.artifactId,
      emergencyBackupPath: originalMoved ? emergencyPath : null,
      appliedManifestPath,
    };
  } catch (error) {
    await rm(temporaryTarget, { force: true });
    if (originalMoved) {
      try {
        await access(targetPath);
      } catch {
        await rename(emergencyPath, targetPath);
      }
    }
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
