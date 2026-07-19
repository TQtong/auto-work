import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { DiagnosticsService } from '../diagnostics/diagnostics.service.js';
import { QuarterlyExportDocxService } from './quarterly-export-docx.service.js';
import {
  QUARTERLY_EXPORT_TEMPLATE_VERSION,
  type QuarterlyExportFacts,
  type QuarterlyExportFormat,
  type QuarterlyGeneratedArtifact,
} from './quarterly-export.types.js';
import { QuarterlyExportXlsxService } from './quarterly-export-xlsx.service.js';

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

@Injectable()
export class QuarterlyExportService {
  private readonly exportRoot: string;

  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly xlsx: QuarterlyExportXlsxService,
    private readonly docx: QuarterlyExportDocxService,
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() private readonly diagnostics?: DiagnosticsService,
  ) {
    this.exportRoot = resolve(config.dataDir, 'quarterly-exports');
  }

  public async queue(
    reviewId: string,
    input: { confirmationId: string; format: QuarterlyExportFormat },
    context: MutationContext,
  ) {
    await this.diagnostics?.assertGrowthAllowed('quarterly_export.queue');
    // 制品唯一键绑定确认快照和模板版本；重复请求只重放，失败/取消才递增尝试重新排队。
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      });
      if (!review)
        throw new DomainError(errorCodes.notFound, '季度绩效自评不存在', { httpStatus: 404 });
      const confirmation = await tx.quarterlyReviewConfirmation.findFirst({
        where: { id: input.confirmationId, reviewId },
      });
      if (!confirmation)
        throw new DomainError(errorCodes.notFound, '季度确认快照不存在', { httpStatus: 404 });
      if (confirmation.status !== 'active' || review.currentConfirmationId !== confirmation.id) {
        throw new DomainError(
          'QUARTERLY_EXPORT_ACTIVE_CONFIRMATION_REQUIRED',
          '只能导出当前有效的确认快照',
          {
            httpStatus: 409,
            suggestedAction: 'refresh',
          },
        );
      }
      const existing = await tx.exportArtifact.findUnique({
        where: {
          reviewId_inputSnapshotHash_format_templateVersion: {
            reviewId,
            inputSnapshotHash: confirmation.snapshotHash,
            format: input.format,
            templateVersion: QUARTERLY_EXPORT_TEMPLATE_VERSION,
          },
        },
      });
      if (existing && ['queued', 'running', 'succeeded'].includes(existing.status)) {
        return { replayed: true, artifact: this.serialize(existing) };
      }

      const jobId = newId();
      await tx.job.create({
        data: {
          id: jobId,
          type: 'quarterly-review.export',
          payloadRef: existing?.id ?? null,
          payloadSummary: JSON.stringify({
            reviewId,
            confirmationId: confirmation.id,
            format: input.format,
            snapshotHash: confirmation.snapshotHash,
          }),
          scheduledAt: new Date(),
          priority: 70,
          maxAttempts: 2,
          dedupeKey: `quarterly-review.export:${reviewId}:${confirmation.snapshotHash}:${input.format}:${QUARTERLY_EXPORT_TEMPLATE_VERSION}`,
        },
      });

      const artifact = existing
        ? await tx.exportArtifact.update({
            where: { id: existing.id },
            data: {
              status: 'queued',
              attemptCount: { increment: 1 },
              version: { increment: 1 },
              jobId,
              fileName: null,
              storedName: null,
              mimeType: null,
              contentHash: null,
              sizeBytes: null,
              qaStatus: 'pending',
              qaReportJson: '{}',
              rendererFactsJson: '{}',
              errorCode: null,
              errorSummary: null,
              startedAt: null,
              completedAt: null,
            },
          })
        : await tx.exportArtifact.create({
            data: {
              id: newId(),
              reviewId,
              confirmationId: confirmation.id,
              format: input.format,
              templateVersion: QUARTERLY_EXPORT_TEMPLATE_VERSION,
              inputSnapshotHash: confirmation.snapshotHash,
              jobId,
              createdBy: this.sessions.currentProfileId,
            },
          });
      if (!existing) {
        await tx.job.update({ where: { id: jobId }, data: { payloadRef: artifact.id } });
      }
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: existing ? 'quarterly_export.requeued' : 'quarterly_export.queued',
        targetType: 'export_artifact',
        targetId: artifact.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { reviewId, confirmationId: confirmation.id, format: input.format, jobId },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { replayed: false, artifact: this.serialize(artifact) };
    });
  }

  public async list(reviewId: string) {
    await this.assertOwnedReview(reviewId);
    const rows = await this.prisma.exportArtifact.findMany({
      where: { reviewId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => this.serialize(row));
  }

  public async get(reviewId: string, artifactId: string) {
    const row = await this.ownedArtifact(reviewId, artifactId);
    return this.serialize(row, true);
  }

  public async execute(
    jobId: string,
    artifactId: string,
    reportProgress: (progress: number) => Promise<void>,
    isCancellationRequested: () => Promise<boolean>,
  ) {
    // 先把 queued 原子推进到 running，再读取冻结快照，整个生成过程不回看活动成果或实时评分。
    let artifact = await this.prisma.exportArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact)
      throw new DomainError('QUARTERLY_EXPORT_NOT_FOUND', '导出制品不存在', { httpStatus: 404 });
    if (artifact.jobId !== jobId) {
      throw new DomainError('QUARTERLY_EXPORT_JOB_MISMATCH', '导出制品与作业不匹配', {
        httpStatus: 409,
      });
    }
    if (artifact.status === 'succeeded') return { replayed: true, artifactId };
    if (artifact.status === 'queued') {
      artifact = await this.prisma.exportArtifact.update({
        where: { id: artifact.id },
        data: { status: 'running', startedAt: new Date(), version: { increment: 1 } },
      });
    } else if (artifact.status !== 'running') {
      throw new DomainError('QUARTERLY_EXPORT_STATE_CONFLICT', '导出制品当前状态不可执行', {
        httpStatus: 409,
      });
    }
    if (await isCancellationRequested()) return this.cancelRunning(artifact.id, 'JOB_CANCELLED');

    await reportProgress(15);
    const facts = await this.frozenFacts(artifact.confirmationId, artifact.inputSnapshotHash);
    const generated = await this.generate(artifact.format as QuarterlyExportFormat, facts);
    if (!generated.qaReport.passed) {
      throw new DomainError('QUARTERLY_EXPORT_QA_FAILED', '导出文件未通过结构验收', {
        httpStatus: 422,
        details: generated.qaReport,
      });
    }
    await reportProgress(70);
    if (await isCancellationRequested()) return this.cancelRunning(artifact.id, 'JOB_CANCELLED');

    const contentHash = createHash('sha256').update(generated.buffer).digest('hex');
    const storedName = `${artifact.reviewId}/${artifact.id}.${generated.extension}`;
    const finalPath = this.resolveStoredPath(storedName);
    await this.writeAtomically(finalPath, generated.buffer, contentHash);
    if (await isCancellationRequested())
      return this.cancelRunning(artifact.id, 'JOB_CANCELLED_AFTER_WRITE');

    const fileName = this.safeFileName(
      `${facts.review.name}-${facts.review.periodStart}-${facts.review.periodEnd}.${generated.extension}`,
    );
    const completed = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.exportArtifact.updateMany({
        where: { id: artifact.id, status: 'running', jobId },
        data: {
          status: 'succeeded',
          version: { increment: 1 },
          fileName,
          storedName,
          mimeType: generated.mimeType,
          contentHash,
          sizeBytes: generated.buffer.length,
          qaStatus: 'passed',
          qaReportJson: JSON.stringify(generated.qaReport),
          rendererFactsJson: JSON.stringify(generated.rendererFacts),
          completedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new DomainError('QUARTERLY_EXPORT_STATE_CONFLICT', '导出制品完成状态写入冲突', {
          httpStatus: 409,
        });
      }
      await tx.quarterlyReview.updateMany({
        where: {
          id: artifact.reviewId,
          currentConfirmationId: artifact.confirmationId,
          status: 'confirmed',
        },
        data: { status: 'exported', version: { increment: 1 } },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        actorId: artifact.createdBy,
        action: 'quarterly_export.succeeded',
        targetType: 'export_artifact',
        targetId: artifact.id,
        correlationId: `job:${jobId}`,
        outcome: 'succeeded',
        after: { contentHash, sizeBytes: generated.buffer.length, qaPassed: true },
        clientSessionHash: requestHash({ jobId, actorId: artifact.createdBy }),
      });
      return tx.exportArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    });
    await reportProgress(95);
    return { replayed: false, artifact: this.serialize(completed) };
  }

  public async markQueuedCancellation(jobId: string, artifactId: string): Promise<void> {
    await this.prisma.exportArtifact.updateMany({
      where: { id: artifactId, jobId, status: 'queued' },
      data: {
        status: 'cancelled',
        version: { increment: 1 },
        errorCode: 'JOB_CANCELLED',
        errorSummary: '作业在排队阶段被取消',
        completedAt: new Date(),
      },
    });
  }

  public async markUnexpectedFailure(
    jobId: string,
    artifactId: string,
    errorCode: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const artifact = await tx.exportArtifact.findFirst({
        where: { id: artifactId, jobId, status: 'running' },
      });
      if (!artifact) return;
      await tx.exportArtifact.update({
        where: { id: artifact.id },
        data: {
          status: 'failed',
          version: { increment: 1 },
          qaStatus: 'failed',
          qaReportJson: JSON.stringify({ passed: false, terminalErrorCode: errorCode }),
          errorCode,
          errorSummary: '导出作业执行失败，请检查作业错误后重试',
          completedAt: new Date(),
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        actorId: artifact.createdBy,
        action: 'quarterly_export.failed',
        targetType: 'export_artifact',
        targetId: artifact.id,
        correlationId: `job:${jobId}`,
        outcome: 'failed',
        after: { errorCode },
        clientSessionHash: requestHash({ jobId, actorId: artifact.createdBy }),
        errorCode,
      });
    });
  }

  public async download(reviewId: string, artifactId: string, context: MutationContext) {
    // 下载是最后一道信任边界：即使数据库显示成功，也必须重新核对路径、大小、哈希和 ZIP 魔数。
    const row = await this.ownedArtifact(reviewId, artifactId);
    if (
      row.status !== 'succeeded' ||
      row.qaStatus !== 'passed' ||
      !row.storedName ||
      !row.contentHash ||
      !row.sizeBytes ||
      !row.mimeType ||
      !row.fileName
    ) {
      throw new DomainError('QUARTERLY_EXPORT_NOT_READY', '导出文件尚未成功生成', {
        httpStatus: 409,
      });
    }
    const path = this.resolveStoredPath(row.storedName);
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch {
      throw new DomainError('QUARTERLY_EXPORT_FILE_MISSING', '导出文件缺失，禁止下载不完整制品', {
        httpStatus: 409,
      });
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    const magicValid = buffer.subarray(0, 2).toString('hex') === '504b';
    if (hash !== row.contentHash || buffer.length !== row.sizeBytes || !magicValid) {
      throw new DomainError('QUARTERLY_EXPORT_FILE_CORRUPTED', '导出文件完整性校验失败，禁止下载', {
        httpStatus: 409,
        suggestedAction: 'manual_review',
      });
    }
    await this.audit.record({
      actorId: this.sessions.currentProfileId,
      action: 'quarterly_export.downloaded',
      targetType: 'export_artifact',
      targetId: row.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after: { contentHash: row.contentHash, sizeBytes: row.sizeBytes },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return { buffer, fileName: row.fileName, mimeType: row.mimeType };
  }

  private async frozenFacts(
    confirmationId: string,
    expectedHash: string,
  ): Promise<QuarterlyExportFacts> {
    const row = await this.prisma.quarterlyReviewConfirmation.findUnique({
      where: { id: confirmationId },
    });
    if (!row || row.snapshotHash !== expectedHash) {
      throw new DomainError('QUARTERLY_EXPORT_SNAPSHOT_MISMATCH', '确认快照与导出输入不一致', {
        httpStatus: 409,
      });
    }
    const template = this.parse<QuarterlyExportFacts['template'] | null>(
      row.templateSnapshotJson,
      null,
    );
    const narrative = this.parse<QuarterlyExportFacts['narrative'] | null>(
      row.narrativeSnapshotJson,
      null,
    );
    if (!template || !narrative) {
      throw new DomainError('QUARTERLY_EXPORT_SNAPSHOT_INCOMPLETE', '确认快照缺少指标模板或正文', {
        httpStatus: 409,
      });
    }
    const frozenReview = this.parse<QuarterlyExportFacts['review'] | null>(
      row.reviewSnapshotJson,
      null,
    );
    if (!frozenReview?.id || frozenReview.id !== row.reviewId) {
      throw new DomainError(
        'QUARTERLY_EXPORT_SNAPSHOT_INCOMPLETE',
        '确认快照缺少冻结的季度基本信息',
        {
          httpStatus: 409,
        },
      );
    }
    return {
      confirmation: {
        id: row.id,
        snapshotHash: row.snapshotHash,
        status: row.status,
        confirmedAt: row.confirmedAt.toISOString(),
        confirmedBy: row.confirmedBy,
        achievementsHash: row.achievementsHash,
        scoresHash: row.scoresHash,
      },
      review: frozenReview,
      achievements: this.parse(row.achievementsSnapshotJson, []),
      template,
      scores: this.parse(row.scoresSnapshotJson, []),
      narrative,
      calculation: this.parse(row.calculationJson, {
        formulaType: template.formulaType,
        roundingRule: template.roundingRule,
        rawTotal: 0,
        finalTotal: 0,
        scoreCount: 0,
        metricCount: template.metrics.length,
      }),
      completeness: this.parse(row.completenessSnapshotJson, {}),
      acknowledgements: this.parse(row.completenessAckJson, []),
    };
  }

  private async generate(
    format: QuarterlyExportFormat,
    facts: QuarterlyExportFacts,
  ): Promise<QuarterlyGeneratedArtifact> {
    if (format === 'xlsx') return this.xlsx.generate(facts);
    if (format === 'docx') return this.docx.generate(facts);
    throw new DomainError('QUARTERLY_EXPORT_FORMAT_UNSUPPORTED', '不支持的季度导出格式', {
      httpStatus: 422,
    });
  }

  private async cancelRunning(artifactId: string, code: string) {
    await this.prisma.exportArtifact.updateMany({
      where: { id: artifactId, status: 'running' },
      data: {
        status: 'cancelled',
        version: { increment: 1 },
        errorCode: code,
        errorSummary: '用户已取消导出作业',
        completedAt: new Date(),
      },
    });
    return { cancelled: true, artifactId };
  }

  private async assertOwnedReview(reviewId: string): Promise<void> {
    const count = await this.prisma.quarterlyReview.count({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (count !== 1)
      throw new DomainError(errorCodes.notFound, '季度绩效自评不存在', { httpStatus: 404 });
  }

  private async ownedArtifact(reviewId: string, artifactId: string) {
    const row = await this.prisma.exportArtifact.findFirst({
      where: {
        id: artifactId,
        reviewId,
        review: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
    });
    if (!row) throw new DomainError(errorCodes.notFound, '导出制品不存在', { httpStatus: 404 });
    return row;
  }

  private async writeAtomically(path: string, buffer: Buffer, contentHash: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${newId()}.tmp`;
    await writeFile(temporary, buffer, { flag: 'wx' });
    try {
      await rename(temporary, path);
    } catch {
      const existing = await this.readIfExists(path);
      if (existing && createHash('sha256').update(existing).digest('hex') === contentHash) {
        await unlink(temporary).catch(() => undefined);
        return;
      }
      // 制品尚未成功入账时，路径只归属当前 artifact；崩溃或取消后的残留文件可以安全替换。
      if (existing) await unlink(path);
      try {
        await rename(temporary, path);
      } catch (replacementError) {
        await unlink(temporary).catch(() => undefined);
        throw replacementError;
      }
    }
  }

  private async readIfExists(path: string): Promise<Buffer | null> {
    try {
      await access(path, constants.R_OK);
      return await readFile(path);
    } catch {
      return null;
    }
  }

  private resolveStoredPath(storedName: string): string {
    const target = resolve(this.exportRoot, storedName);
    if (!target.startsWith(`${this.exportRoot}${sep}`)) {
      throw new DomainError('QUARTERLY_EXPORT_PATH_INVALID', '导出文件路径越界', {
        httpStatus: 500,
      });
    }
    return target;
  }

  private safeFileName(value: string): string {
    const extension = value.toLowerCase().endsWith('.docx') ? '.docx' : '.xlsx';
    const stem = basename(value, extension)
      .replace(/[<>:"/\\|?*]/gu, '_')
      .replace(/[\p{Cc}]/gu, '_')
      .replace(/[. ]+$/gu, '')
      .slice(0, 120);
    return `${stem || '季度绩效自评'}${extension}`;
  }

  private serialize(
    row: {
      id: string;
      reviewId: string;
      confirmationId: string;
      format: string;
      templateVersion: string;
      inputSnapshotHash: string;
      status: string;
      attemptCount: number;
      version: number;
      jobId: string | null;
      fileName: string | null;
      mimeType: string | null;
      contentHash: string | null;
      sizeBytes: number | null;
      qaStatus: string;
      qaReportJson: string;
      rendererFactsJson: string;
      errorCode: string | null;
      errorSummary: string | null;
      createdAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
      updatedAt: Date;
    },
    detailed = false,
  ) {
    return {
      id: row.id,
      reviewId: row.reviewId,
      confirmationId: row.confirmationId,
      format: row.format,
      templateVersion: row.templateVersion,
      inputSnapshotHash: row.inputSnapshotHash,
      status: row.status,
      attemptCount: row.attemptCount,
      version: row.version,
      jobId: row.jobId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      qaStatus: row.qaStatus,
      errorCode: row.errorCode,
      errorSummary: row.errorSummary,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      ...(detailed
        ? {
            qaReport: this.parse(row.qaReportJson, {}),
            rendererFacts: this.parse(row.rendererFactsJson, {}),
          }
        : {}),
    };
  }

  private parse<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
