import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { newId, requestHash } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

const DIAGNOSTIC_EXCLUSIONS = [
  '凭证、Token、Webhook、Cookie、Authorization 与保险箱引用',
  '周报、绩效、自评、AI 输入输出和附件正文',
  '仓库、数据库、备份和导出文件的绝对路径',
  'HTTP 原始请求/响应、作业 payload 和未脱敏错误堆栈',
] as const;

interface DiagnosticBundleDocument {
  bundleId: string;
  generatedAt: string;
  formatVersion: 'diagnostic-bundle-v1';
  exclusions: readonly string[];
  facts: Awaited<ReturnType<DiagnosticsService['facts']>>;
}

@Injectable()
export class DiagnosticsService {
  private readonly directory: string;

  public constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.directory = join(config.dataDir, 'diagnostics');
  }

  public exclusions(): readonly string[] {
    return DIAGNOSTIC_EXCLUSIONS;
  }

  public async facts(includeRecentErrors = true) {
    const generatedAt = new Date();
    const [readiness, schema, jobGroups, integrationGroups, backupRows, auditCount, recentErrors] =
      await Promise.all([
        this.prisma.readiness(),
        this.prisma.schemaMetadata.findUnique({ where: { id: 1 } }),
        this.prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.integrationConnection.groupBy({
          by: ['type', 'status'],
          _count: { _all: true },
        }),
        this.prisma.backupArtifact.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
        this.prisma.auditEvent.count(),
        includeRecentErrors
          ? this.prisma.appEventLog.findMany({
              where: { level: { in: ['error', 'fatal'] } },
              orderBy: { timestamp: 'desc' },
              take: 50,
              select: {
                timestamp: true,
                level: true,
                component: true,
                eventName: true,
                outcome: true,
                errorCode: true,
                durationMs: true,
              },
            })
          : Promise.resolve([]),
      ]);
    const [storage, database] = await Promise.all([this.storageFacts(), this.databaseFacts()]);
    const latestBackup = backupRows[0];
    const latestVerified = backupRows.find((item) => item.status === 'verified');
    return {
      generatedAt: generatedAt.toISOString(),
      runtime: {
        applicationVersion: schema?.applicationVersion ?? 'unknown',
        schemaChecksum: schema?.schemaChecksum ?? 'unknown',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
        environment: this.config.environment,
        binding: { host: this.config.host, port: this.config.port, loopbackOnly: true },
      },
      database: { ...database, readiness },
      storage,
      jobs: Object.fromEntries(jobGroups.map((item) => [item.status, item._count._all])),
      integrations: integrationGroups.map((item) => ({
        type: item.type,
        status: item.status,
        count: item._count._all,
      })),
      backups: {
        totalRecorded: backupRows.length,
        latestStatus: latestBackup?.status ?? null,
        latestCreatedAt: latestBackup?.createdAt.toISOString() ?? null,
        latestVerifiedAt: latestVerified?.verifiedAt?.toISOString() ?? null,
        verificationAgeHours: latestVerified?.verifiedAt
          ? Math.round(
              ((generatedAt.getTime() - latestVerified.verifiedAt.getTime()) / 3_600_000) * 10,
            ) / 10
          : null,
      },
      audit: { immutableEventCount: auditCount },
      recentErrors: recentErrors.map((item) => ({
        ...item,
        timestamp: item.timestamp.toISOString(),
      })),
    };
  }

  public async createBundle(includeRecentErrors: boolean) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const bundleId = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `diagnostic-${timestamp}-${bundleId}.json`;
    const finalPath = join(this.directory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    const document: DiagnosticBundleDocument = {
      bundleId,
      generatedAt: new Date().toISOString(),
      formatVersion: 'diagnostic-bundle-v1',
      exclusions: DIAGNOSTIC_EXCLUSIONS,
      facts: await this.facts(includeRecentErrors),
    };
    // 排除项需要明确写出“凭证/Webhook”等名词；脱敏扫描只检查事实区，避免把安全说明误报为泄漏。
    this.assertRedacted(JSON.stringify(document.facts));
    const content = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, finalPath);
    const fileStat = await stat(finalPath);
    return {
      bundleId,
      fileName,
      sizeBytes: fileStat.size,
      sha256: createHash('sha256').update(content).digest('hex'),
      createdAt: document.generatedAt,
    };
  }

  public async listBundles() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const bundles = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^diagnostic-.+-[0-9a-f-]{36}\.json$/i.test(entry.name))
        .map(async (entry) => {
          const path = join(this.directory, entry.name);
          const [content, fileStat] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
          const parsed = JSON.parse(content) as Pick<DiagnosticBundleDocument, 'bundleId' | 'generatedAt'>;
          return {
            bundleId: parsed.bundleId,
            fileName: entry.name,
            sizeBytes: fileStat.size,
            sha256: createHash('sha256').update(content).digest('hex'),
            createdAt: parsed.generatedAt,
          };
        }),
    );
    return bundles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async openBundle(bundleId: string) {
    const bundle = (await this.listBundles()).find((item) => item.bundleId === bundleId);
    if (!bundle) return null;
    return { ...bundle, stream: createReadStream(join(this.directory, bundle.fileName)) };
  }

  private async databaseFacts() {
    const [pageCountRows, pageSizeRows, freeListRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ page_count: bigint | number }>>('PRAGMA page_count'),
      this.prisma.$queryRawUnsafe<Array<{ page_size: bigint | number }>>('PRAGMA page_size'),
      this.prisma.$queryRawUnsafe<Array<{ freelist_count: bigint | number }>>(
        'PRAGMA freelist_count',
      ),
    ]);
    return {
      journalMode: 'WAL',
      pageCount: Number(pageCountRows[0]?.page_count ?? 0),
      pageSizeBytes: Number(pageSizeRows[0]?.page_size ?? 0),
      freePageCount: Number(freeListRows[0]?.freelist_count ?? 0),
      databaseLocationHash: requestHash({ location: this.config.databaseUrl }),
    };
  }

  private async storageFacts() {
    const fileSystem = await statfs(this.config.dataDir, { bigint: true });
    const categories = await Promise.all(
      ['backups', 'quarterly-exports', 'weekly-report-exports', 'diagnostics', 'tmp'].map(
        async (name) => [name, await this.directorySize(join(this.config.dataDir, name))] as const,
      ),
    );
    const databasePath = this.config.databaseUrl.slice('file:'.length).replaceAll('/', '\\');
    const databaseFiles = await Promise.all(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) =>
        stat(path)
          .then((item) => item.size)
          .catch(() => 0),
      ),
    );
    const blockSize = fileSystem.bsize;
    return {
      totalBytes: Number(fileSystem.blocks * blockSize),
      availableBytes: Number(fileSystem.bavail * blockSize),
      databaseBytes: databaseFiles.reduce((total, size) => total + size, 0),
      categories: Object.fromEntries(categories),
      dataDirectoryHash: requestHash({ location: this.config.dataDir }),
    };
  }

  private async directorySize(path: string): Promise<number> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += await this.directorySize(child);
      else if (entry.isFile()) total += await stat(child).then((item) => item.size);
    }
    return total;
  }

  private assertRedacted(content: string): void {
    const forbidden = [
      /authorization/i,
      /bearer\s+[a-z0-9._-]+/i,
      /credential(ref|mask)?/i,
      /access[_-]?token/i,
      /webhook/i,
      /payload(summary|ref)?/i,
    ];
    if (forbidden.some((pattern) => pattern.test(content))) {
      throw new Error('诊断包脱敏自检失败，已拒绝落盘');
    }
  }
}
