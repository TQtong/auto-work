import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { RetentionService } from '../src/modules/diagnostics/retention.service.js';

describe('留存预览、范围防漂移与受控清理', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: RetentionService;
  const policy = { eventLogDays: 30, terminalJobDays: 90, diagnosticBundleDays: 30 };

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-retention-'));
    const databasePath = join(temporaryDirectory, 'retention.db');
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
    const now = new Date();
    const old = new Date(now.getTime() - 120 * 86_400_000);
    await prisma.userProfile.create({
      data: { id: 'local-user', windowsSid: 'S-1-5-21-retention', displayName: '留存验收用户' },
    });
    await prisma.appEventLog.createMany({
      data: [
        { id: 'old-log', timestamp: old, level: 'error', component: 'test', eventName: 'old' },
        { id: 'new-log', timestamp: now, level: 'info', component: 'test', eventName: 'new' },
      ],
    });
    await prisma.idempotencyRecord.create({
      data: {
        id: 'expired-key',
        actorId: 'local-user',
        route: '/test',
        idempotencyKey: 'expired',
        requestHash: 'hash',
        expiresAt: old,
      },
    });
    await prisma.job.createMany({
      data: [
        {
          id: 'old-job',
          type: 'test.old',
          status: 'succeeded',
          scheduledAt: old,
          completedAt: old,
        },
        { id: 'queued-job', type: 'test.queued', status: 'queued', scheduledAt: old },
      ],
    });
    await prisma.auditEvent.create({
      data: {
        eventId: 'audit-preserved',
        occurredAt: old,
        actorType: 'local_user',
        actorId: 'local-user',
        action: 'test.audit',
        targetType: 'test',
        targetId: 'target',
        correlationId: 'correlation',
        outcome: 'succeeded',
        clientSessionHash: 'session-hash',
      },
    });
    await prisma.backupArtifact.create({
      data: { id: 'backup-preserved', status: 'verified', verifiedAt: old },
    });
    const diagnostics = join(temporaryDirectory, 'diagnostics');
    await mkdir(diagnostics);
    const oldBundle = join(diagnostics, 'diagnostic-old.json');
    await writeFile(oldBundle, '{}');
    await utimes(oldBundle, old, old);
    const config: AppConfig = {
      host: '127.0.0.1',
      port: 3760,
      dataDir: temporaryDirectory,
      webDist: join(temporaryDirectory, 'web'),
      databaseUrl: `file:${databasePath.replaceAll('\\', '/')}`,
      repositoryRoot: join(temporaryDirectory, 'repositories'),
      logLevel: 'info',
      environment: 'test',
    };
    service = new RetentionService(prisma as unknown as PrismaService, config);
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('预览明确区分待清对象和永久保留边界', async () => {
    const preview = await service.preview(policy);
    expect(preview.candidates).toEqual({
      eventLogs: 1,
      expiredIdempotency: 1,
      terminalJobs: 1,
      diagnosticBundles: 1,
      diagnosticBytes: 2,
    });
    expect(preview.preserved).toMatchObject({
      auditEvents: 1,
      verifiedBackups: 1,
      businessFacts: '全部保留',
    });
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('拒绝过期预览哈希并按有效预览清理且不触碰保留对象', async () => {
    await expect(service.execute(policy, '0'.repeat(64))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const preview = await service.preview(policy);
    const result = await service.execute(policy, preview.previewHash);
    expect(result.deleted).toEqual(preview.candidates);
    expect(await prisma.appEventLog.findMany({ orderBy: { id: 'asc' } })).toHaveLength(1);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    expect(await prisma.job.findMany()).toHaveLength(1);
    expect(await prisma.auditEvent.count()).toBe(1);
    expect(await prisma.backupArtifact.count()).toBe(1);
    expect(await prisma.userProfile.count()).toBe(1);
    expect(await readdir(join(temporaryDirectory, 'diagnostics'))).toEqual([]);
  });
});
