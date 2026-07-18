import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';

export interface RetentionPolicy {
  eventLogDays: number;
  terminalJobDays: number;
  diagnosticBundleDays: number;
}

@Injectable()
export class RetentionService {
  private readonly diagnosticsDirectory: string;

  public constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.diagnosticsDirectory = join(config.dataDir, 'diagnostics');
  }

  public async preview(policy: RetentionPolicy) {
    const now = new Date();
    const eventLogBefore = this.cutoff(now, policy.eventLogDays);
    const terminalJobBefore = this.cutoff(now, policy.terminalJobDays);
    const diagnosticBefore = this.cutoff(now, policy.diagnosticBundleDays);
    const [eventLogs, expiredIdempotency, terminalJobs, files, auditEvents, exports, backups] =
      await Promise.all([
        this.prisma.appEventLog.count({ where: { timestamp: { lt: eventLogBefore } } }),
        this.prisma.idempotencyRecord.count({ where: { expiresAt: { lt: now } } }),
        this.prisma.job.count({
          where: {
            status: { in: ['succeeded', 'failed', 'cancelled', 'dead_letter'] },
            completedAt: { lt: terminalJobBefore },
          },
        }),
        this.diagnosticCandidates(diagnosticBefore),
        this.prisma.auditEvent.count(),
        this.prisma.exportArtifact.count(),
        this.prisma.backupArtifact.count({ where: { status: 'verified' } }),
      ]);
    const candidates = {
      eventLogs,
      expiredIdempotency,
      terminalJobs,
      diagnosticBundles: files.length,
      diagnosticBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    };
    const preserved = {
      auditEvents,
      exportArtifacts: exports,
      verifiedBackups: backups,
      businessFacts: '全部保留',
      credentials: '不参与普通文件留存',
    };
    return {
      generatedAt: now.toISOString(),
      policy,
      candidates,
      preserved,
      previewHash: requestHash({ policy, candidates, preserved }),
    };
  }

  public async execute(policy: RetentionPolicy, expectedPreviewHash: string) {
    const preview = await this.preview(policy);
    if (preview.previewHash !== expectedPreviewHash) {
      throw new DomainError(errorCodes.versionConflict, '留存候选已经变化，请重新预览后确认', {
        httpStatus: 409,
        suggestedAction: 'refresh',
        details: { currentPreviewHash: preview.previewHash },
      });
    }
    const now = new Date();
    const eventLogBefore = this.cutoff(now, policy.eventLogDays);
    const terminalJobBefore = this.cutoff(now, policy.terminalJobDays);
    const diagnosticBefore = this.cutoff(now, policy.diagnosticBundleDays);
    const files = await this.diagnosticCandidates(diagnosticBefore);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const eventLogs = await tx.appEventLog.deleteMany({
        where: { timestamp: { lt: eventLogBefore } },
      });
      const expiredIdempotency = await tx.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      const terminalJobs = await tx.job.deleteMany({
        where: {
          status: { in: ['succeeded', 'failed', 'cancelled', 'dead_letter'] },
          completedAt: { lt: terminalJobBefore },
        },
      });
      return {
        eventLogs: eventLogs.count,
        expiredIdempotency: expiredIdempotency.count,
        terminalJobs: terminalJobs.count,
      };
    });
    let diagnosticBundles = 0;
    let diagnosticBytes = 0;
    for (const file of files) {
      await unlink(file.path);
      diagnosticBundles += 1;
      diagnosticBytes += file.sizeBytes;
    }
    return {
      previewHash: expectedPreviewHash,
      deleted: { ...deleted, diagnosticBundles, diagnosticBytes },
      preserved: preview.preserved,
      completedAt: new Date().toISOString(),
    };
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000);
  }

  private async diagnosticCandidates(before: Date) {
    const entries = await readdir(this.diagnosticsDirectory, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^diagnostic-.+\.json$/iu.test(entry.name))
        .map(async (entry) => {
          const path = join(this.diagnosticsDirectory, entry.name);
          const fileStat = await stat(path);
          return { path, sizeBytes: fileStat.size, modifiedAt: fileStat.mtime };
        }),
    );
    return candidates.filter((file) => file.modifiedAt < before);
  }
}
