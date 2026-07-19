import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DomainError } from '@auto-work/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { LocalSecurityService } from '../src/infrastructure/http/local-security.service.js';
import type { CredentialVault } from '../src/infrastructure/vault/credential-vault.js';
import type { AiProviderClient } from '../src/modules/ai/ai-provider.client.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import { QuarterlyCompletenessService } from '../src/modules/quarterly-reviews/quarterly-completeness.service.js';
import { QuarterlyNarrativeConfirmationService } from '../src/modules/quarterly-reviews/quarterly-narrative-confirmation.service.js';
import { QuarterlyReviewController } from '../src/modules/quarterly-reviews/quarterly-review.controller.js';
import { QuarterlyReviewService } from '../src/modules/quarterly-reviews/quarterly-review.service.js';
import { QuarterlyReviewAiService } from '../src/modules/quarterly-reviews/quarterly-review-ai.service.js';
import type { SessionService } from '../src/modules/session/session.service.js';

describe('季度自评版本、确认前置检查与完整冻结快照', () => {
  let temporaryDirectory = '';
  let prisma: PrismaClient;
  let reviews: QuarterlyReviewService;
  let narratives: QuarterlyNarrativeConfirmationService;
  let controller: QuarterlyReviewController;
  let quarterlyAi: QuarterlyReviewAiService;
  let confirmedReviewId = '';
  const generate = vi.fn<AiProviderClient['generate']>();

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-quarterly-confirmation-'));
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'quarterly-confirmation.db').replaceAll('\\', '/')}`,
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
        windowsSid: 'S-1-5-21-quarterly-confirmation',
        displayName: '季度确认用户',
        timezone: 'Asia/Shanghai',
      },
    });
    const prismaService = prisma as unknown as PrismaService;
    const sessions = { currentProfileId: 'local-user' } as SessionService;
    const audit = new AuditService(prismaService);
    const security = {
      sessionHash: (value: string) => createHash('sha256').update(value).digest('hex'),
    } as LocalSecurityService;
    const completeness = new QuarterlyCompletenessService();
    reviews = new QuarterlyReviewService(prismaService, sessions, audit, security, completeness);
    narratives = new QuarterlyNarrativeConfirmationService(
      prismaService,
      sessions,
      audit,
      security,
      completeness,
    );
    controller = new QuarterlyReviewController(
      reviews,
      {} as never,
      {} as never,
      narratives,
      {} as never,
      {} as never,
      new IdempotencyService(prismaService),
      sessions,
    );
    quarterlyAi = new QuarterlyReviewAiService(
      prismaService,
      sessions,
      audit,
      security,
      { generate } as unknown as AiProviderClient,
      narratives,
      {
        get: vi.fn().mockResolvedValue(JSON.stringify({ apiKey: 'test-provider-key' })),
      } as unknown as CredentialVault,
    );
    await prisma.integrationConnection.create({
      data: {
        id: 'quarterly-ai-provider',
        type: 'ai',
        name: '季度 AI 测试连接',
        baseUrl: 'https://ai.example.test/v1',
        credentialRef: 'vault-quarterly-ai',
        credentialMask: 'tes***key',
        status: 'healthy',
        configJson: JSON.stringify({
          protocol: 'openai_compatible',
          model: 'quarterly-test-model',
          metadataOnly: true,
          timeoutMs: 10_000,
          maxInputTokens: 32_000,
          maxOutputTokens: 4_096,
          temperaturePolicy: 'deterministic',
          temperature: 0,
          allowedPurposes: ['quarterly_review', 'score_suggestion'],
        }),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('确认冻结五类可重建正文，后续人工评分修改只失效旧确认而不改写历史', async () => {
    const review = await reviews.create(
      { periodType: 'natural_quarter', year: 2028, quarter: 2 },
      context('create'),
    );
    confirmedReviewId = review.id;
    const template = await reviews.createMetricTemplate(
      {
        name: '季度确认模板',
        formulaType: 'weighted_average_100',
        roundingRule: 'half_up_1_decimal',
        metrics: [
          {
            code: 'delivery',
            name: '业务交付',
            definition: '依据成果和证据评价交付质量',
            weight: 100,
            minimum: 1,
            maximum: 5,
            step: 0.5,
            required: true,
            evidenceRequirement: { minimumEvidence: 1 },
            enabled: true,
          },
        ],
      },
      context('template'),
    );
    const bound = await reviews.bindMetricTemplate(
      review.id,
      { templateVersionId: template.versionId, reviewVersion: review.version },
      context('bind'),
    );
    await prisma.achievement.create({
      data: {
        id: 'achievement-confirm',
        reviewId: review.id,
        sourceType: 'manual',
        sourceKey: 'manual:confirmation',
        title: '完成季度核心交付',
        situation: '季度目标明确且存在交付时限',
        action: '完成方案、实现和验收闭环',
        result: '交付物通过验收',
        impact: '业务流程可稳定运行',
        contributionBoundary: '本人负责实现，团队共同验收',
        periodStart: '2028-04-01',
        periodEnd: '2028-06-30',
        selectionStatus: 'selected',
        evidenceStatus: 'complete',
        createdBy: 'local-user',
      },
    });
    await prisma.achievementEvidence.create({
      data: {
        id: 'evidence-confirm',
        achievementId: 'achievement-confirm',
        sourceType: 'manual',
        sourceId: 'acceptance-record',
        title: '验收记录',
        eventAt: new Date('2028-06-30T08:00:00.000Z'),
        sourceContentHash: createHash('sha256').update('acceptance-record').digest('hex'),
        contributionAngle: '证明交付完成并通过验收',
        primaryEvidence: true,
      },
    });
    await prisma.achievementMetricLink.create({
      data: {
        id: 'link-confirm',
        achievementId: 'achievement-confirm',
        metricId: template.metrics[0]!.id,
        contribution: '该成果直接支撑业务交付指标',
        createdBy: 'local-user',
      },
    });
    const scored = await reviews.updateScores(
      review.id,
      {
        reviewVersion: bound.reviewVersion,
        scores: [
          {
            metricId: template.metrics[0]!.id,
            userScore: 4.5,
            userReason: '依据验收记录和本人贡献边界进行人工评分',
          },
        ],
      },
      context('score'),
    );
    const narrative = await narratives.createRuleNarrative(
      review.id,
      { reviewVersion: scored.reviewVersion },
      context('narrative'),
    );
    const preflight = await narratives.preflight(review.id, narrative.narrative.id);
    expect(preflight).toMatchObject({
      confirmable: true,
      requiredAcknowledgements: [expect.objectContaining({ code: 'SOURCE_FRESHNESS_RISK' })],
    });
    const missingAcknowledgementInput = {
      reviewVersion: narrative.reviewVersion,
      narrativeVersionId: narrative.narrative.id,
      acknowledgements: [],
    };
    await expect(
      controller.confirm(review.id, missingAcknowledgementInput, undefined, request('missing-key')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(
      controller.confirm(
        review.id,
        missingAcknowledgementInput,
        'quarterly-missing-ack',
        request('missing-ack'),
      ),
    ).rejects.toMatchObject({ code: 'QUARTERLY_COMPLETENESS_ACK_REQUIRED' });
    expect(
      await prisma.idempotencyRecord.findFirstOrThrow({
        where: { idempotencyKey: 'quarterly-missing-ack' },
      }),
    ).toMatchObject({ state: 'failed', errorCode: 'QUARTERLY_COMPLETENESS_ACK_REQUIRED' });

    const confirmationInput = {
      reviewVersion: narrative.reviewVersion,
      narrativeVersionId: narrative.narrative.id,
      acknowledgements: [
        { code: 'SOURCE_FRESHNESS_RISK', reason: '已人工复核本周期来源与验收记录' },
      ],
    };
    const firstEnvelope = await controller.confirm(
      review.id,
      confirmationInput,
      'quarterly-confirm-success',
      request('confirm'),
    );
    const confirmed = firstEnvelope.data as Awaited<ReturnType<typeof narratives.confirm>>;
    expect(confirmed.confirmation).toMatchObject({
      status: 'active',
      calculation: { finalTotal: 4.5 },
      achievementsSnapshot: [expect.objectContaining({ id: 'achievement-confirm' })],
      scoresSnapshot: [expect.objectContaining({ userScore: 4.5 })],
    });
    expect(confirmed.confirmation.templateSnapshot).toMatchObject({ id: template.versionId });
    expect(confirmed.confirmation.narrativeSnapshot).toMatchObject({
      id: narrative.narrative.id,
    });
    expect(confirmed.confirmation.completenessSnapshot).toMatchObject({
      materialCompletenessOnly: true,
    });
    expect(confirmed.confirmation.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    const idempotentReplay = await controller.confirm(
      review.id,
      confirmationInput,
      'quarterly-confirm-success',
      request('confirm-idempotent-replay'),
    );
    expect(idempotentReplay.data).toEqual(firstEnvelope.data);
    await expect(
      controller.confirm(
        review.id,
        {
          ...confirmationInput,
          acknowledgements: [
            { code: 'SOURCE_FRESHNESS_RISK', reason: '同一键不得替换首次请求内容' },
          ],
        },
        'quarterly-confirm-success',
        request('confirm-conflict'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const businessReplayEnvelope = await controller.confirm(
      review.id,
      {
        ...confirmationInput,
        acknowledgements: [{ code: 'SOURCE_FRESHNESS_RISK', reason: '新请求也不得创建第二份确认' }],
      },
      'quarterly-confirm-business-replay',
      request('confirm-business-replay'),
    );
    expect(businessReplayEnvelope.data).toMatchObject({
      replayed: true,
      confirmation: { id: confirmed.confirmation.id },
      reviewVersion: confirmed.reviewVersion,
    });
    expect(await prisma.quarterlyReviewConfirmation.count({ where: { reviewId: review.id } })).toBe(
      1,
    );
    expect(
      await prisma.idempotencyRecord.findFirstOrThrow({
        where: { idempotencyKey: 'quarterly-confirm-success' },
      }),
    ).toMatchObject({ state: 'completed', httpStatus: 201, errorCode: null });

    await reviews.updateScores(
      review.id,
      {
        reviewVersion: confirmed.reviewVersion,
        scores: [
          {
            metricId: template.metrics[0]!.id,
            userScore: 4,
            userReason: '补充复核后调整人工评分，历史确认仍应保留',
          },
        ],
      },
      context('invalidate'),
    );
    const historical = await narratives.getConfirmation(review.id, confirmed.confirmation.id);
    expect(historical).toMatchObject({
      status: 'invalidated',
      scoresSnapshot: [expect.objectContaining({ userScore: 4.5 })],
    });
    expect(historical.invalidationReason).toContain('用户评分');
  });

  it('AI 失败时确定性回退规则自评，评分建议成功时也绝不改写用户评分', async () => {
    const fallbackReview = await reviews.create(
      { periodType: 'natural_quarter', year: 2029, quarter: 1 },
      context('fallback-create'),
    );
    await prisma.achievement.create({
      data: {
        id: 'achievement-fallback',
        reviewId: fallbackReview.id,
        sourceType: 'manual',
        sourceKey: 'manual:fallback',
        title: '准备季度材料',
        situation: '本周期需要形成可核对材料',
        action: '整理成果结构并人工复核',
        result: '形成完整候选材料',
        impact: '支持后续绩效确认',
        contributionBoundary: '本人负责整理，最终内容由本人确认',
        periodStart: '2029-01-01',
        periodEnd: '2029-03-31',
        selectionStatus: 'selected',
        evidenceStatus: 'needs_evidence',
        createdBy: 'local-user',
      },
    });
    generate.mockRejectedValueOnce(
      new DomainError('AI_RATE_LIMITED', '供应商限流', { httpStatus: 503, retryable: true }),
    );
    const fallback = await quarterlyAi.generate(
      fallbackReview.id,
      'quarterly_review',
      { reviewVersion: fallbackReview.version, providerConnectionId: 'quarterly-ai-provider' },
      context('ai-fallback'),
    );
    expect(fallback).toMatchObject({
      fallback: true,
      fallbackReasonCode: 'AI_RATE_LIMITED',
      generation: { status: 'failed', adoptionStatus: 'not_applicable' },
      fallbackNarrative: {
        narrative: { origin: 'rule' },
      },
    });
    if (!('fallbackNarrative' in fallback) || !fallback.fallbackNarrative) {
      throw new Error('预期 AI 失败后生成规则自评');
    }
    expect(
      await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: fallbackReview.id } }),
    ).toMatchObject({ currentNarrativeVersionId: fallback.fallbackNarrative.narrative.id });

    const fallbackAfterRule = await prisma.quarterlyReview.findUniqueOrThrow({
      where: { id: fallbackReview.id },
    });
    generate.mockImplementationOnce((input) => {
      const prompt = JSON.parse(input.request.userPrompt) as {
        input: { selectedAchievements: Array<{ refId: string }> };
      };
      const citation = prompt.input.selectedAchievements[0]!.refId;
      return Promise.resolve({
        protocol: 'openai_compatible',
        model: 'quarterly-test-model-observed',
        outputText: JSON.stringify({
          sections: [
            'overallOverview',
            'coreAchievements',
            'collaborationAndGrowth',
            'problemsAndImprovements',
            'nextPeriodPlan',
          ].map((section) => ({
            section,
            text: '依据已选成果整理，具体事实由用户复核。',
            citations: [citation],
          })),
        }),
        stopReason: 'stop',
        providerRequestId: 'quarterly-narrative-request',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      });
    });
    const aiNarrative = await quarterlyAi.generate(
      fallbackReview.id,
      'quarterly_review',
      {
        reviewVersion: fallbackAfterRule.version,
        providerConnectionId: 'quarterly-ai-provider',
      },
      context('ai-narrative'),
    );
    expect(aiNarrative).toMatchObject({
      fallback: false,
      generation: { status: 'succeeded', adoptionStatus: 'pending' },
      currentNarrativeVersionId: fallback.fallbackNarrative.narrative.id,
    });
    const adopted = await narratives.adoptAiNarrative(
      fallbackReview.id,
      aiNarrative.generation.id,
      {
        reviewVersion: fallbackAfterRule.version,
        decisionReason: '已逐段核对引用后采纳为人工版本',
      },
      context('ai-adopt'),
    );
    expect(adopted).toMatchObject({ replayed: false, narrative: { origin: 'manual' } });
    expect(
      await prisma.aiGeneration.findUniqueOrThrow({ where: { id: aiNarrative.generation.id } }),
    ).toMatchObject({
      adoptionStatus: 'adopted',
      adoptedNarrativeVersionId: adopted.narrative.id,
    });

    const before = await prisma.quarterlyReview.findUniqueOrThrow({
      where: { id: confirmedReviewId },
    });
    const userScoreBefore = await prisma.scoreItem.findFirstOrThrow({
      where: { reviewId: confirmedReviewId },
    });
    generate.mockImplementationOnce((input) => {
      const prompt = JSON.parse(input.request.userPrompt) as {
        input: {
          metrics: Array<{ id: string }>;
          selectedAchievements: Array<{ refId: string }>;
        };
      };
      return Promise.resolve({
        protocol: 'openai_compatible',
        model: 'quarterly-test-model-observed',
        outputText: JSON.stringify({
          suggestions: prompt.input.metrics.map((metric) => ({
            metricId: metric.id,
            suggestedScore: 4.5,
            suggestedMinimum: 4,
            suggestedMaximum: 5,
            reason: '依据已选成果及验收证据，建议用户人工复核。',
            evidenceGaps: [],
            uncertainty: 'low',
            citations: [prompt.input.selectedAchievements[0]!.refId],
          })),
        }),
        stopReason: 'stop',
        providerRequestId: 'quarterly-score-request',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      });
    });
    const scoreSuggestion = await quarterlyAi.generate(
      confirmedReviewId,
      'score_suggestion',
      { reviewVersion: before.version, providerConnectionId: 'quarterly-ai-provider' },
      context('ai-score'),
    );
    expect(scoreSuggestion).toMatchObject({ fallback: false, generation: { status: 'succeeded' } });
    const scoreAfter = await prisma.scoreItem.findUniqueOrThrow({
      where: { id: userScoreBefore.id },
    });
    expect(scoreAfter).toMatchObject({
      userScore: userScoreBefore.userScore,
      userReason: userScoreBefore.userReason,
      aiSuggestedScore: 4.5,
      aiSuggestedMinimum: 4,
      aiSuggestedMaximum: 5,
      aiGenerationId: scoreSuggestion.generation.id,
    });
    expect(
      await prisma.quarterlyReview.findUniqueOrThrow({ where: { id: confirmedReviewId } }),
    ).toMatchObject({ version: before.version });
  });

  function context(suffix: string) {
    return { correlationId: `corr-${suffix}`, sessionId: `session-${suffix}` };
  }

  function request(suffix: string) {
    return {
      autoWork: {
        correlationId: `corr-${suffix}`,
        sessionId: `session-${suffix}`,
      },
    } as never;
  }
});
