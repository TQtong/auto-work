import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { DiagnosticsService } from '../src/modules/diagnostics/diagnostics.service.js';
import { BackupHandlers } from '../src/modules/backup/backup.handlers.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';

describe('备份校验、恢复准备与取消', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let handlers: BackupHandlers;
  let registry: JobRegistryService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-backup-recovery-'));
    const databasePath = join(temporaryDirectory, 'auto-work.db');
    prisma = new PrismaClient({ datasourceUrl: `file:${databasePath.replaceAll('\\', '/')}` });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }
    const config: AppConfig = {
      host: '127.0.0.1',
      port: 3760,
      dataDir: temporaryDirectory,
      webDist: join(temporaryDirectory, 'web'),
      databaseUrl: `file:${databasePath.replaceAll('\\', '/')}`,
      repositoryRoot: join(temporaryDirectory, 'repositories'),
      vaultBackend: 'sealed',
      vaultKeyFile: join(temporaryDirectory, 'vault-master.key'),
      logLevel: 'info',
      environment: 'test',
    };
    registry = new JobRegistryService();
    handlers = new BackupHandlers(
      prisma as unknown as PrismaService,
      registry,
      {
        assertGrowthAllowed: vi.fn().mockResolvedValue(undefined),
      } as unknown as DiagnosticsService,
      config,
    );
    handlers.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('创建备份时冻结 schema，完整性/外键校验后才允许恢复', async () => {
    const create = registry.get('backup.create')!;
    const created = (await create.execute(context('create', null))) as {
      artifactId: string;
      schemaChecksum: string;
    };
    expect(created.schemaChecksum).toBe('20260719080000_operations_restore_metadata');

    const beforeVerify = await handlers.restorePreflight(created.artifactId);
    expect(beforeVerify).toMatchObject({ status: 'succeeded', compatible: false });

    const verify = registry.get('backup.verify')!;
    await expect(verify.execute(context('verify', created.artifactId))).resolves.toMatchObject({
      quickCheck: 'ok',
      foreignKeyViolations: 0,
      schemaChecksum: created.schemaChecksum,
    });
    const preflight = await handlers.restorePreflight(created.artifactId);
    expect(preflight).toMatchObject({
      status: 'verified',
      compatible: true,
    });
    expect(preflight?.confirmationText?.startsWith('恢复 auto-work-')).toBe(true);
  });

  it('准备恢复前生成安全备份，持久化清单并可在重启前取消', async () => {
    const source = await prisma.backupArtifact.findFirstOrThrow({ where: { status: 'verified' } });
    const restore = registry.get('backup.restore.prepare')!;
    const result = await restore.execute(context('restore', source.id));
    expect(result).toMatchObject({
      artifactId: source.id,
      restartRequired: true,
      replayed: false,
    });
    expect(await prisma.backupArtifact.count()).toBe(2);
    await expect(handlers.pendingRestore()).resolves.toMatchObject({
      artifactId: source.id,
      restartRequired: true,
    });
    await expect(handlers.cancelPendingRestore()).resolves.toMatchObject({ artifactId: source.id });
    await expect(handlers.pendingRestore()).resolves.toBeNull();
  });
});

function context(jobId: string, payloadRef: string | null) {
  return {
    jobId,
    payloadRef,
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    reportProgress: vi.fn().mockResolvedValue(undefined),
  };
}
