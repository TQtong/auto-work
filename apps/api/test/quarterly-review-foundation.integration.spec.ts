import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { QuarterlyReviewService } from '../src/modules/quarterly-reviews/quarterly-review.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('季度评审周期、指标模板与用户评分内核', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let service: QuarterlyReviewService;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-quarterly-foundation-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'quarterly.db').replaceAll('\\', '/')}`,
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
    await prisma.userProfile.create({
      data: {
        id: 'local-user',
        windowsSid: 'S-1-5-21-quarterly-foundation',
        displayName: '季度验收用户',
        timezone: 'Asia/Shanghai',
      },
    });
    service = new QuarterlyReviewService(
      prisma as unknown as PrismaService,
      { currentProfileId: 'local-user' } as SessionService,
      new AuditService(prisma as unknown as PrismaService),
      {
        sessionHash: (value: string) => createHash('sha256').update(value).digest('hex'),
      } as LocalSecurityService,
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('创建自然季度并由数据库阻止周期定义原地修改', async () => {
    const review = await service.create(
      { periodType: 'natural_quarter', year: 2026, quarter: 2 },
      context('create-review'),
    );
    expect(review).toMatchObject({
      name: '2026 Q2',
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      nextPeriodStart: '2026-07-01',
      status: 'draft',
      version: 1,
    });
    await expect(
      prisma.quarterlyReview.update({
        where: { id: review.id },
        data: { periodEnd: '2026-06-29', version: { increment: 1 } },
      }),
    ).rejects.toBeTruthy();
    await expect(
      service.create(
        { periodType: 'natural_quarter', year: 2026, quarter: 2 },
        context('duplicate-review'),
      ),
    ).rejects.toMatchObject({ code: 'QUARTERLY_PERIOD_CONFLICT' });
  });

  it('拒绝权重合计错误的模板，合法模板版本和指标均不可变', async () => {
    await expect(
      service.createMetricTemplate(
        {
          name: '错误模板',
          formulaType: 'weighted_average_100',
          roundingRule: 'half_up_1_decimal',
          metrics: [metric('delivery', '业务交付', 80), metric('quality', '质量', 10)],
        },
        context('invalid-template'),
      ),
    ).rejects.toMatchObject({ code: 'PERFORMANCE_WEIGHT_TOTAL_INVALID' });
    expect(await prisma.performanceMetricTemplate.count()).toBe(0);

    const template = await service.createMetricTemplate(
      {
        name: '研发绩效模板',
        formulaType: 'weighted_average_100',
        roundingRule: 'half_up_1_decimal',
        metrics: [
          metric('delivery', '业务交付', 40),
          metric('quality', '质量稳定', 35),
          metric('growth', '协作成长', 25),
        ],
      },
      context('valid-template'),
    );
    expect(template.metrics).toHaveLength(3);
    expect(template.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      prisma.performanceMetric.update({
        where: { id: template.metrics[0]!.id },
        data: { weight: 100 },
      }),
    ).rejects.toBeTruthy();
  });

  it('绑定明确模板版本，逐项用户分不同且按未舍入贡献计算总分', async () => {
    const review = await service.create(
      {
        periodType: 'custom',
        name: '2026 下半年专项',
        periodStart: '2026-07-01',
        periodEnd: '2026-12-31',
      },
      context('custom-review'),
    );
    const templates = await service.listMetricTemplates();
    const current = templates[0]!.currentVersion!;
    const bound = await service.bindMetricTemplate(
      review.id,
      { templateVersionId: current.id, reviewVersion: review.version },
      context('bind-template'),
    );
    const metrics = current.metrics;
    const first = await service.updateScores(
      review.id,
      {
        reviewVersion: bound.reviewVersion,
        scores: [{ metricId: metrics[0]!.id, userScore: 4.5, userReason: '业务交付证据充分' }],
      },
      context('partial-score'),
    );
    expect(first.calculation).toBeNull();
    const detailAfterPartial = await service.get(review.id);
    expect(
      detailAfterPartial.scores.find((score) => score.metricId === metrics[0]!.id),
    ).toMatchObject({
      userScore: 4.5,
      validationStatus: 'valid',
      rawContribution: 1.8,
    });

    const completed = await service.updateScores(
      review.id,
      {
        reviewVersion: first.reviewVersion,
        scores: [
          { metricId: metrics[1]!.id, userScore: 4, userReason: '质量事实可核对' },
          { metricId: metrics[2]!.id, userScore: 3.5, userReason: '协作评审记录充分' },
        ],
      },
      context('complete-score'),
    );
    expect(completed.calculation).toMatchObject({ rawTotal: 4.075, finalTotal: 4.1 });
    const detail = await service.get(review.id);
    expect(detail.scores.map((score) => score.userScore)).toEqual([4.5, 4, 3.5]);
    expect(detail.scores.every((score) => score.aiSuggestedScore === null)).toBe(true);
  });

  it('不完整评分也不能绕过单项步长、范围和理由校验', async () => {
    const review = await service.create(
      { periodType: 'natural_quarter', year: 2027, quarter: 1 },
      context('invalid-score-review'),
    );
    const current = (await service.listMetricTemplates())[0]!.currentVersion!;
    const bound = await service.bindMetricTemplate(
      review.id,
      { templateVersionId: current.id, reviewVersion: review.version },
      context('invalid-score-bind'),
    );
    await expect(
      service.updateScores(
        review.id,
        {
          reviewVersion: bound.reviewVersion,
          scores: [{ metricId: current.metrics[0]!.id, userScore: 4.3, userReason: '非法步长' }],
        },
        context('invalid-score'),
      ),
    ).rejects.toMatchObject({ code: 'PERFORMANCE_SCORE_RANGE_INVALID' });
    const score = await prisma.scoreItem.findUniqueOrThrow({
      where: { reviewId_metricId: { reviewId: review.id, metricId: current.metrics[0]!.id } },
    });
    expect(score.userScore).toBeNull();
  });

  function context(suffix: string) {
    return { correlationId: `corr-${suffix}`, sessionId: `session-${suffix}` };
  }
});

function metric(code: string, name: string, weight: number) {
  return {
    code,
    name,
    definition: `${name}的可核对定义`,
    weight,
    minimum: 1,
    maximum: 5,
    step: 0.5,
    required: true,
    evidenceRequirement: { minimumEvidence: 1 },
    enabled: true,
  };
}
