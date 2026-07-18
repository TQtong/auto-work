import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { DiagnosticsService } from '../src/modules/diagnostics/diagnostics.service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('DiagnosticsService', () => {
  it('原子生成可列举且不含受禁字段的脱敏诊断包', async () => {
    const { service, dataDir } = await createService();
    vi.spyOn(service, 'facts').mockResolvedValue(safeFacts());

    const created = await service.createBundle(true);
    const listed = await service.listBundles();
    const content = await readFile(join(dataDir, 'diagnostics', created.fileName), 'utf8');
    const document = JSON.parse(content) as { facts: unknown };

    expect(listed).toEqual([created]);
    expect(content).toContain('diagnostic-bundle-v1');
    expect(content).toContain('JOB_TEST_FAILED');
    expect(JSON.stringify(document.facts)).not.toMatch(
      /authorization|credentialRef|access_token|payloadSummary/i,
    );
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('内容自检发现潜在敏感字段时拒绝落盘', async () => {
    const { service } = await createService();
    const facts = safeFacts();
    facts.recentErrors[0]!.eventName = 'Authorization header rejected';
    vi.spyOn(service, 'facts').mockResolvedValue(facts);

    await expect(service.createBundle(true)).rejects.toThrow('诊断包脱敏自检失败');
    await expect(service.listBundles()).resolves.toEqual([]);
  });

  it('磁盘余量低于绝对或百分比阈值时阻断增长型操作', async () => {
    const { service } = await createService();
    vi.spyOn(service, 'capacity').mockResolvedValue({
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 4 * 1024 ** 3,
      minimumAvailableBytes: 5 * 1024 ** 3,
      growthAllowed: false,
    });

    await expect(service.assertGrowthAllowed('quarterly_export.queue')).rejects.toMatchObject({
      code: 'DISK_SPACE_LOW',
      options: {
        httpStatus: 507,
        retryable: false,
        suggestedAction: 'manual_review',
        details: {
          operation: 'quarterly_export.queue',
          availableBytes: 4 * 1024 ** 3,
          requestedBytes: 0,
          minimumAvailableBytes: 5 * 1024 ** 3,
        },
      },
    });
  });
});

async function createService() {
  const dataDir = await mkdtemp(join(tmpdir(), 'auto-work-diagnostics-'));
  temporaryDirectories.push(dataDir);
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3760,
    dataDir,
    webDist: join(dataDir, 'web'),
    databaseUrl: `file:${join(dataDir, 'auto-work.db').replaceAll('\\', '/')}`,
    repositoryRoot: join(dataDir, 'repositories'),
    logLevel: 'info',
    environment: 'test',
  };
  const service = new DiagnosticsService({} as PrismaService, config);
  return { service, dataDir };
}

function safeFacts(): Awaited<ReturnType<DiagnosticsService['facts']>> {
  return {
    generatedAt: '2026-07-19T00:00:00.000Z',
    runtime: {
      applicationVersion: '0.1.0',
      schemaChecksum: 'schema',
      nodeVersion: 'v22.14.0',
      platform: 'win32',
      architecture: 'x64',
      uptimeSeconds: 10,
      environment: 'test',
      binding: { host: '127.0.0.1', port: 3760, loopbackOnly: true },
    },
    database: {
      journalMode: 'WAL',
      pageCount: 10,
      pageSizeBytes: 4096,
      freePageCount: 1,
      databaseLocationHash: 'database-hash',
      readiness: { ready: true, quickCheck: 'ok' },
    },
    storage: {
      totalBytes: 1_000_000,
      availableBytes: 800_000,
      minimumAvailableBytes: 50_000,
      growthAllowed: true,
      databaseBytes: 20_000,
      categories: { backups: 10_000, diagnostics: 0 },
      dataDirectoryHash: 'data-hash',
    },
    jobs: { succeeded: 2, failed: 1 },
    integrations: [{ type: 'jira', status: 'healthy', count: 1 }],
    backups: {
      totalRecorded: 1,
      latestStatus: 'verified',
      latestCreatedAt: '2026-07-19T00:00:00.000Z',
      latestVerifiedAt: '2026-07-19T00:00:00.000Z',
      verificationAgeHours: 0,
    },
    audit: { immutableEventCount: 3 },
    recentErrors: [
      {
        timestamp: '2026-07-19T00:00:00.000Z',
        level: 'error',
        component: 'JobRunnerService',
        eventName: 'job.failed',
        outcome: 'failed',
        errorCode: 'JOB_TEST_FAILED',
        durationMs: 25,
      },
    ],
  };
}
