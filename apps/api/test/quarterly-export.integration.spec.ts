import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/app-config.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { QuarterlyExportDocxService } from '../src/modules/quarterly-reviews/quarterly-export-docx.service.js';
import { QuarterlyReviewController } from '../src/modules/quarterly-reviews/quarterly-review.controller.js';
import { QuarterlyExportService } from '../src/modules/quarterly-reviews/quarterly-export.service.js';
import { QuarterlyExportXlsxService } from '../src/modules/quarterly-reviews/quarterly-export-xlsx.service.js';
import type { QuarterlyExportFacts } from '../src/modules/quarterly-reviews/quarterly-export.types.js';
import type { SessionService } from '../src/modules/session/session.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('季度绩效 Excel/Word 不可变快照导出', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: QuarterlyExportService;
  let controller: QuarterlyReviewController;
  const reviewId = 'quarterly-export-review';
  const confirmationId = 'quarterly-export-confirmation';
  const narrativeId = 'quarterly-export-narrative';
  const templateVersionId = 'quarterly-export-template-v1';
  const frozen = frozenFacts();

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-quarterly-export-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'quarterly-export.db').replaceAll('\\', '/')}`,
    });
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
    await seedConfirmation();
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    service = new QuarterlyExportService(
      prismaService,
      sessions,
      new AuditService(prismaService),
      { sessionHash: (sessionId: string) => hash(sessionId) } as LocalSecurityService,
      new QuarterlyExportXlsxService(),
      new QuarterlyExportDocxService(),
      {
        dataDir: temporaryDirectory,
        host: '127.0.0.1',
        port: 3760,
        webDist: temporaryDirectory,
        databaseUrl: 'file:test',
        repositoryRoot: temporaryDirectory,
        logLevel: 'info',
        environment: 'test',
      } satisfies AppConfig,
    );
    controller = new QuarterlyReviewController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      service,
      new IdempotencyService(prismaService),
      sessions,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('安全重放 Excel 作业，并以公式、类型化日期、超链接和确认总分生成真实文件', async () => {
    const queued = await service.queue(
      reviewId,
      { confirmationId, format: 'xlsx' },
      context('xlsx-queue'),
    );
    expect(queued).toMatchObject({
      replayed: false,
      artifact: { status: 'queued', format: 'xlsx' },
    });
    const replay = await service.queue(
      reviewId,
      { confirmationId, format: 'xlsx' },
      context('xlsx-replay'),
    );
    expect(replay).toMatchObject({ replayed: true, artifact: { id: queued.artifact.id } });

    // 模拟生成器在进入 running 后耗尽重试，验证失败收尾、审计和同制品重排。
    await prisma.exportArtifact.update({
      where: { id: queued.artifact.id },
      data: { status: 'running', startedAt: new Date(), version: { increment: 1 } },
    });
    await prisma.job.update({
      where: { id: queued.artifact.jobId! },
      data: { status: 'failed', completedAt: new Date(), lastErrorCode: 'TEST_EXPORT_FAILED' },
    });
    await service.markUnexpectedFailure(
      queued.artifact.jobId!,
      queued.artifact.id,
      'TEST_EXPORT_FAILED',
    );
    expect(await service.get(reviewId, queued.artifact.id)).toMatchObject({
      status: 'failed',
      qaStatus: 'failed',
      errorCode: 'TEST_EXPORT_FAILED',
    });
    expect(
      await prisma.auditEvent.count({
        where: { action: 'quarterly_export.failed', targetId: queued.artifact.id },
      }),
    ).toBe(1);
    const retried = await service.queue(
      reviewId,
      { confirmationId, format: 'xlsx' },
      context('xlsx-retry'),
    );
    expect(retried).toMatchObject({
      replayed: false,
      artifact: { id: queued.artifact.id, attemptCount: 1, status: 'queued' },
    });

    // 改写聚合根上的可变完整性事实，证明生成器不回读确认后的实时状态。
    await prisma.quarterlyReview.update({
      where: { id: reviewId },
      data: {
        completenessJson: JSON.stringify({ selectedWithoutEvidenceCount: 99 }),
        version: { increment: 1 },
      },
    });
    const progress: number[] = [];
    await service.execute(
      retried.artifact.jobId!,
      retried.artifact.id,
      (value) => {
        progress.push(value);
        return Promise.resolve();
      },
      () => Promise.resolve(false),
    );
    expect(progress).toEqual([15, 70, 95]);
    const detail = await service.get(reviewId, retried.artifact.id);
    expect(detail).toMatchObject({
      status: 'succeeded',
      qaStatus: 'passed',
      qaReport: { passed: true },
    });

    const downloaded = await service.download(
      reviewId,
      retried.artifact.id,
      context('xlsx-download'),
    );
    await preserveQaArtifact('quarterly-review.xlsx', downloaded.buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(downloaded.buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '绩效自评',
      '指标评分',
      '成果明细',
      '证据索引',
      '数据说明',
    ]);
    expect(workbook.getWorksheet('绩效自评')!.getCell('B6').text).toContain('确认时冻结的总体概述');
    expect(workbook.getWorksheet('绩效自评')!.getCell('B6').text).not.toContain('后续改写');
    expect(workbook.getWorksheet('成果明细')!.getCell('H2').value).toBeInstanceOf(Date);
    expect(workbook.getWorksheet('证据索引')!.getCell('H2').value).toMatchObject({
      hyperlink: 'https://example.test/evidence/acceptance',
    });
    const totalFormula = workbook.getWorksheet('指标评分')!.getCell('J3').value;
    expect(totalFormula).toMatchObject({ result: 4.5 });
    expect(
      totalFormula && typeof totalFormula === 'object' && 'formula' in totalFormula
        ? String(totalFormula.formula)
        : '',
    ).toContain('SUM');
  });

  it('排队取消后复用同一制品重试，并生成含页眉页脚、确认正文和外链的 Word 文件', async () => {
    const queued = await service.queue(
      reviewId,
      { confirmationId, format: 'docx' },
      context('docx-queue'),
    );
    await service.markQueuedCancellation(queued.artifact.jobId!, queued.artifact.id);
    await prisma.job.update({
      where: { id: queued.artifact.jobId! },
      data: { status: 'cancelled', cancelRequested: true, completedAt: new Date() },
    });
    expect(await service.get(reviewId, queued.artifact.id)).toMatchObject({ status: 'cancelled' });

    const retried = await service.queue(
      reviewId,
      { confirmationId, format: 'docx' },
      context('docx-retry'),
    );
    expect(retried).toMatchObject({
      replayed: false,
      artifact: { id: queued.artifact.id, status: 'queued', attemptCount: 1 },
    });
    await service.execute(
      retried.artifact.jobId!,
      retried.artifact.id,
      () => Promise.resolve(),
      () => Promise.resolve(false),
    );
    const detail = await service.get(reviewId, retried.artifact.id);
    expect(detail).toMatchObject({
      status: 'succeeded',
      qaStatus: 'passed',
      rendererFacts: {
        designPreset: 'standard_business_brief',
        headerPattern: 'editorial_cover',
      },
    });
    const downloaded = await service.download(
      reviewId,
      retried.artifact.id,
      context('docx-download'),
    );
    await preserveQaArtifact('quarterly-review.docx', downloaded.buffer);
    expect(downloaded.buffer.subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('文件被篡改后拒绝下载，避免把损坏制品交给用户', async () => {
    const artifact = await prisma.exportArtifact.findFirstOrThrow({
      where: { reviewId, format: 'xlsx' },
    });
    await writeFile(
      join(temporaryDirectory, 'quarterly-exports', reviewId, `${artifact.id}.xlsx`),
      Buffer.from('tampered'),
    );
    await expect(
      service.download(reviewId, artifact.id, context('corrupted')),
    ).rejects.toMatchObject({
      code: 'QUARTERLY_EXPORT_FILE_CORRUPTED',
    });
  });

  it('HTTP 导出契约强制幂等键、重放首次响应并拒绝同键异参', async () => {
    const request = {
      autoWork: {
        correlationId: 'corr-export-http-idempotency',
        sessionId: 'session-export-http-idempotency',
      },
    } as never;
    await expect(
      controller.queueExport(reviewId, { confirmationId, format: 'xlsx' }, undefined, request),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const first = await controller.queueExport(
      reviewId,
      { confirmationId, format: 'xlsx' },
      'quarterly-export-http-0001',
      request,
    );
    const replay = await controller.queueExport(
      reviewId,
      { confirmationId, format: 'xlsx' },
      'quarterly-export-http-0001',
      request,
    );
    expect(replay).toEqual(first);

    await expect(
      controller.queueExport(
        reviewId,
        { confirmationId, format: 'docx' },
        'quarterly-export-http-0001',
        request,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  async function seedConfirmation(): Promise<void> {
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-quarterly-export',
        displayName: '季度导出用户',
        timezone: 'Asia/Shanghai',
      },
    });
    await prisma.performanceMetricTemplate.create({
      data: { id: 'quarterly-export-template', ownerProfileId: 'local-user', name: '季度导出模板' },
    });
    await prisma.performanceMetricTemplateVersion.create({
      data: {
        id: templateVersionId,
        templateId: 'quarterly-export-template',
        versionNo: 1,
        formulaType: frozen.template.formulaType,
        roundingRule: frozen.template.roundingRule,
        contentHash: frozen.template.contentHash,
        createdBy: 'local-user',
      },
    });
    await prisma.performanceMetricTemplate.update({
      where: { id: 'quarterly-export-template' },
      data: { currentVersionId: templateVersionId, version: { increment: 1 } },
    });
    await prisma.quarterlyReview.create({
      data: {
        id: reviewId,
        ownerProfileId: 'local-user',
        name: frozen.review.name,
        periodStart: frozen.review.periodStart,
        periodEnd: frozen.review.periodEnd,
        nextPeriodStart: '2029-07-01',
        year: 2029,
        quarter: 2,
        status: 'confirmed',
        metricTemplateVersionId: templateVersionId,
        version: frozen.review.version,
      },
    });
    await prisma.reviewNarrativeVersion.create({
      data: {
        id: narrativeId,
        reviewId,
        versionNo: 1,
        origin: frozen.narrative.origin,
        contentJson: JSON.stringify(frozen.narrative.content),
        sourceSnapshotHash: hash('source'),
        contentHash: hash('narrative'),
        createdBy: 'local-user',
      },
    });
    await prisma.quarterlyReview.update({
      where: { id: reviewId },
      data: { currentNarrativeVersionId: narrativeId, version: { increment: 1 } },
    });
    await prisma.quarterlyReviewConfirmation.create({
      data: {
        id: confirmationId,
        reviewId,
        reviewVersion: frozen.review.version,
        metricTemplateVersionId: templateVersionId,
        narrativeVersionId: narrativeId,
        snapshotHash: frozen.confirmation.snapshotHash,
        achievementsHash: frozen.confirmation.achievementsHash,
        scoresHash: frozen.confirmation.scoresHash,
        calculationJson: JSON.stringify(frozen.calculation),
        reviewSnapshotJson: JSON.stringify(frozen.review),
        achievementsSnapshotJson: JSON.stringify(frozen.achievements),
        scoresSnapshotJson: JSON.stringify(frozen.scores),
        templateSnapshotJson: JSON.stringify(frozen.template),
        narrativeSnapshotJson: JSON.stringify(frozen.narrative),
        completenessSnapshotJson: JSON.stringify(frozen.completeness),
        completenessAckJson: JSON.stringify(frozen.acknowledgements),
        confirmedBy: 'local-user',
        confirmedAt: new Date(frozen.confirmation.confirmedAt),
      },
    });
    await prisma.quarterlyReview.update({
      where: { id: reviewId },
      data: { currentConfirmationId: confirmationId, version: { increment: 1 } },
    });
  }
});

function frozenFacts(): QuarterlyExportFacts {
  const snapshotHash = hash('quarterly-export-snapshot');
  return {
    confirmation: {
      id: 'quarterly-export-confirmation',
      snapshotHash,
      status: 'active',
      confirmedAt: '2029-06-30T10:00:00.000Z',
      confirmedBy: 'local-user',
      achievementsHash: hash('achievements'),
      scoresHash: hash('scores'),
    },
    review: {
      id: 'quarterly-export-review',
      name: '2029 年第二季度绩效自评',
      periodStart: '2029-04-01',
      periodEnd: '2029-06-30',
      timezone: 'Asia/Shanghai',
      version: 3,
    },
    achievements: [
      {
        id: 'achievement-frozen',
        projectId: null,
        projectName: '绩效工作台',
        title: '完成季度绩效闭环交付',
        situation: '季度资料分散且人工核对成本较高。',
        action: '完成收集、证据映射、评分、确认与导出闭环。',
        result: '形成可追溯且可重建的确认快照。',
        impact: '降低整理成本并提升审核可信度。',
        contributionBoundary: '本人负责方案与实现，团队共同完成验收。',
        periodStart: '2029-04-01',
        periodEnd: '2029-06-30',
        evidences: [
          {
            id: 'evidence-frozen',
            sourceType: 'manual_link',
            sourceId: 'acceptance',
            title: '季度验收记录',
            externalKey: 'ACC-2029-Q2',
            eventAt: '2029-06-29T08:00:00.000Z',
            url: 'https://example.test/evidence/acceptance',
            availabilityState: 'available',
            sourceContentHash: hash('evidence'),
            sourceSummary: { conclusion: 'passed' },
            contributionAngle: '证明闭环功能通过验收',
            primaryEvidence: true,
          },
        ],
        metricLinks: [
          {
            id: 'link-frozen',
            metricId: 'metric-delivery',
            contribution: '直接支撑交付指标',
            version: 1,
          },
        ],
      },
    ],
    template: {
      id: 'quarterly-export-template-v1',
      versionNo: 1,
      formulaType: 'weighted_average_100',
      roundingRule: 'half_up_1_decimal',
      contentHash: hash('template'),
      metrics: [
        {
          id: 'metric-delivery',
          code: 'delivery',
          name: '业务交付',
          definition: '依据成果和证据评价季度业务交付质量。',
          weight: 100,
          minimum: 1,
          maximum: 5,
          step: 0.5,
          required: true,
          enabled: true,
          order: 0,
          evidenceRequirement: { minimumEvidence: 1 },
        },
      ],
    },
    scores: [
      {
        metricId: 'metric-delivery',
        userScore: 4.5,
        userReason: '验收记录证明交付完成，贡献边界清楚。',
        rawContribution: 4.5,
        validationStatus: 'valid',
        aiSuggestedScore: 4,
        aiSuggestedMinimum: 3.5,
        aiSuggestedMaximum: 4.5,
        aiReason: '核心闭环已交付，但长期效果仍需后续观察。',
        aiEvidenceGaps: ['缺少下一季度持续使用数据'],
        aiUncertainty: 'medium',
        aiGenerationId: 'ai-score-frozen',
      },
    ],
    narrative: {
      id: 'quarterly-export-narrative',
      versionNo: 1,
      origin: 'manual',
      content: {
        overallOverview: '确认时冻结的总体概述：本季度完成绩效工作台闭环。',
        coreAchievements: [
          {
            heading: '完成季度绩效闭环',
            body: '实现从资料收集到确认导出的全流程，并保留可核对证据。',
            achievementIds: ['achievement-frozen'],
            metricIds: ['metric-delivery'],
            evidenceIds: ['evidence-frozen'],
          },
        ],
        collaborationAndGrowth: '与团队共同完成验收，补齐文档制品工程能力。',
        problemsAndImprovements: '仍需持续观察大数据量下的生成耗时。',
        nextPeriodPlan: '补充长期使用数据并持续优化工作台体验。',
      },
    },
    calculation: {
      formulaType: 'weighted_average_100',
      roundingRule: 'half_up_1_decimal',
      rawTotal: 4.5,
      finalTotal: 4.5,
      scoreCount: 1,
      metricCount: 1,
    },
    completeness: { selectedWithoutEvidenceCount: 0, staleSourceCount: 0 },
    acknowledgements: [],
  };
}

function context(suffix: string) {
  return { correlationId: `corr-${suffix}`, sessionId: `session-${suffix}` };
}

async function preserveQaArtifact(fileName: string, buffer: Buffer): Promise<void> {
  const directory = process.env.QUARTERLY_EXPORT_QA_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), buffer);
}
