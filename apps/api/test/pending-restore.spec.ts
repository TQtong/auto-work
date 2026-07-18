import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import {
  applyPendingRestore,
  type PendingRestoreManifest,
} from '../src/infrastructure/database/pending-restore.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('启动前原子恢复', () => {
  it('校验备份后切换主库并保留紧急副本和已应用清单', async () => {
    const fixture = await createFixture();
    const result = await applyPendingRestore(fixture.config);

    expect(await readFile(fixture.databasePath, 'utf8')).toBe('restored-database');
    expect(result).toMatchObject({
      restoreId: fixture.manifest.restoreId,
      artifactId: fixture.manifest.artifactId,
    });
    expect(await readFile(result!.emergencyBackupPath!, 'utf8')).toBe('current-database');
    expect(await readFile(result!.appliedManifestPath, 'utf8')).toContain(
      fixture.manifest.restoreId,
    );
    await expect(applyPendingRestore(fixture.config)).resolves.toBeNull();
  });

  it('源文件被篡改时拒绝恢复且保持当前数据库和待恢复清单', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.sourcePath, 'tampered');

    await expect(applyPendingRestore(fixture.config)).rejects.toThrow('备份哈希与清单不一致');
    expect(await readFile(fixture.databasePath, 'utf8')).toBe('current-database');
    expect(await readdir(fixture.dataDir)).toContain('pending-restore.json');
  });
});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'auto-work-pending-restore-'));
  temporaryDirectories.push(dataDir);
  const backupRoot = join(dataDir, 'backups');
  await mkdir(backupRoot);
  const databasePath = join(dataDir, 'auto-work.db');
  const sourcePath = join(backupRoot, 'verified.db');
  await writeFile(databasePath, 'current-database');
  await writeFile(sourcePath, 'restored-database');
  const manifest: PendingRestoreManifest = {
    restoreId: randomUUID(),
    artifactId: randomUUID(),
    sourcePath,
    sourceSha256: createHash('sha256').update('restored-database').digest('hex'),
    targetDatabasePath: databasePath,
    schemaChecksum: 'schema-checksum',
    safetyBackupArtifactId: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  await writeFile(join(dataDir, 'pending-restore.json'), JSON.stringify(manifest));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3760,
    dataDir,
    webDist: join(dataDir, 'web'),
    databaseUrl: `file:${databasePath.replaceAll('\\', '/')}`,
    repositoryRoot: join(dataDir, 'repositories'),
    logLevel: 'info',
    environment: 'test',
  };
  return { config, dataDir, databasePath, sourcePath, manifest };
}
