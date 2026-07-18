import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import {
  CREDENTIAL_VAULT,
  type CredentialVault,
} from '../../infrastructure/vault/credential-vault.js';
import { AiProviderClient } from '../ai/ai-provider.client.js';
import { aiProviderConfigSchema } from '../ai/ai-provider.config.js';
import type { AiProviderConfig, AiPurpose, AiUsage } from '../ai/ai-provider.types.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { QuarterlyNarrativeConfirmationService } from './quarterly-narrative-confirmation.service.js';
import {
  buildQuarterlyAiRequest,
  quarterlyAiMaximumRawOutputBytes,
  quarterlyAiPromptTemplateVersion,
  quarterlyAiSanitizationPolicyVersion,
  sanitizeQuarterlyAiInput,
  validateQuarterlyNarrativeOutput,
  validateQuarterlyScoreOutput,
  type QuarterlyAiAchievement,
  type QuarterlyAiMetric,
  type QuarterlyAiPolicyResult,
} from './quarterly-review-ai.policy.js';

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

interface Attempt {
  id: string;
  reviewId: string;
  reviewVersion: number;
  purpose: 'quarterly_review' | 'score_suggestion';
  startedAt: number;
  connection: {
    id: string;
    version: number;
    baseUrl: string;
    credentialRef: string;
    config: AiProviderConfig;
  };
  policy: QuarterlyAiPolicyResult;
}

@Injectable()
export class QuarterlyReviewAiService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly provider: AiProviderClient,
    private readonly narratives: QuarterlyNarrativeConfirmationService,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
  ) {}

  public async generate(
    reviewId: string,
    purpose: Attempt['purpose'],
    input: { reviewVersion: number; providerConnectionId: string },
    context: MutationContext,
  ) {
    const review = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    if (review.version !== input.reviewVersion) this.versionConflict(review.version);
    const connection = await this.resolveConnection(input.providerConnectionId, purpose);
    const facts = await this.loadFacts(reviewId);
    const policy = sanitizeQuarterlyAiInput({
      purpose,
      review: {
        name: review.name,
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        timezone: review.timezone,
      },
      metrics: facts.metrics,
      achievements: facts.achievements,
    });
    const attempt: Attempt = {
      id: newId(),
      reviewId,
      reviewVersion: review.version,
      purpose,
      startedAt: Date.now(),
      connection,
      policy,
    };
    const request = buildQuarterlyAiRequest(policy);
    if (request.estimatedInputTokens > connection.config.maxInputTokens) {
      return this.recordFailure(
        attempt,
        'blocked',
        'AI_INPUT_TOKEN_LIMIT_EXCEEDED',
        ['input_token_limit'],
        context,
      );
    }
    let apiKey: string;
    try {
      const credential = JSON.parse(await this.vault.get(connection.credentialRef)) as unknown;
      if (!this.isObject(credential) || typeof credential.apiKey !== 'string') {
        throw new DomainError('AI_CREDENTIAL_INVALID', 'AI 凭证结构无效', { httpStatus: 422 });
      }
      apiKey = credential.apiKey;
    } catch (error) {
      return this.recordFailure(
        attempt,
        'failed',
        this.errorCode(error, 'AI_CREDENTIAL_UNAVAILABLE'),
        [],
        context,
      );
    }
    let response;
    try {
      response = await this.provider.generate({
        baseUrl: connection.baseUrl,
        apiKey,
        config: connection.config,
        request: {
          purpose,
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          maxOutputTokens: connection.config.maxOutputTokens,
        },
      });
    } catch (error) {
      return this.recordFailure(
        attempt,
        'failed',
        this.errorCode(error, 'AI_PROVIDER_REQUEST_FAILED'),
        [],
        context,
      );
    }
    let parsed: unknown;
    try {
      parsed =
        purpose === 'score_suggestion'
          ? validateQuarterlyScoreOutput(response.outputText, policy)
          : validateQuarterlyNarrativeOutput(response.outputText, policy);
    } catch (error) {
      const blocked = error instanceof DomainError && error.code === 'AI_OUTPUT_SECURITY_BLOCKED';
      return this.recordFailure(
        attempt,
        blocked ? 'blocked' : 'failed',
        this.errorCode(error, 'AI_OUTPUT_VALIDATION_FAILED'),
        blocked ? this.securityCategories(error) : [],
        context,
        {
          rawOutput:
            !blocked &&
            Buffer.byteLength(response.outputText, 'utf8') <= quarterlyAiMaximumRawOutputBytes
              ? response.outputText
              : null,
          protocol: response.protocol,
          model: response.model,
          requestId: response.providerRequestId,
          stopReason: response.stopReason,
          usage: response.usage,
        },
      );
    }
    return this.persistSuccess(attempt, parsed, response, context);
  }

  public async list(reviewId: string, purpose?: string) {
    await this.assertOwnedReview(reviewId);
    const where = {
      quarterlyReviewId: reviewId,
      ownerProfileId: this.sessions.currentProfileId,
      ...(purpose ? { purpose } : {}),
    };
    const [rows, total, review] = await Promise.all([
      this.prisma.aiGeneration.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.aiGeneration.count({ where }),
      this.prisma.quarterlyReview.findUniqueOrThrow({ where: { id: reviewId } }),
    ]);
    return { items: rows.map((row) => this.serialize(row, false, review.version)), total };
  }

  public async get(reviewId: string, generationId: string) {
    const row = await this.prisma.aiGeneration.findFirst({
      where: {
        id: generationId,
        quarterlyReviewId: reviewId,
        ownerProfileId: this.sessions.currentProfileId,
        quarterlyReview: { archivedAt: null },
      },
    });
    if (!row) throw new DomainError(errorCodes.notFound, 'AI 生成记录不存在', { httpStatus: 404 });
    const review = await this.prisma.quarterlyReview.findUniqueOrThrow({ where: { id: reviewId } });
    return this.serialize(row, true, review.version);
  }

  private async persistSuccess(
    attempt: Attempt,
    parsed: unknown,
    response: {
      protocol: AiProviderConfig['protocol'];
      model: string;
      outputText: string;
      stopReason: string;
      providerRequestId: string | null;
      usage: AiUsage;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: {
          id: attempt.reviewId,
          ownerProfileId: this.sessions.currentProfileId,
          archivedAt: null,
          version: attempt.reviewVersion,
        },
      });
      if (!review) this.versionConflict(attempt.reviewVersion);
      const generation = await tx.aiGeneration.create({
        data: {
          ...this.generationBase(attempt),
          rawOutput: response.outputText,
          parsedOutputJson: JSON.stringify(parsed),
          protocol: response.protocol,
          model: response.model,
          providerRequestId: response.providerRequestId,
          stopReason: response.stopReason,
          usageJson: JSON.stringify(response.usage),
          durationMs: Date.now() - attempt.startedAt,
          status: 'succeeded',
          securityBlocksJson: '[]',
          adoptionStatus: attempt.purpose === 'quarterly_review' ? 'pending' : 'not_applicable',
          completedAt: new Date(),
        },
      });
      let suggestionVersionId: string | null = null;
      if (attempt.purpose === 'score_suggestion') {
        const suggestions = parsed as ReturnType<typeof validateQuarterlyScoreOutput>;
        for (const suggestion of suggestions) {
          // 这里只更新 AI 专属列；userScore、userReason 和计算贡献绝不进入写入对象。
          await tx.scoreItem.update({
            where: {
              reviewId_metricId: { reviewId: attempt.reviewId, metricId: suggestion.metricId },
            },
            data: {
              aiSuggestedScore: suggestion.suggestedScore,
              aiSuggestedMinimum: suggestion.suggestedMinimum,
              aiSuggestedMaximum: suggestion.suggestedMaximum,
              aiReason: suggestion.reason,
              aiEvidenceGapsJson: JSON.stringify(suggestion.evidenceGaps),
              aiUncertainty: suggestion.uncertainty,
              aiGenerationId: generation.id,
              version: { increment: 1 },
              updatedBy: this.sessions.currentProfileId,
            },
          });
        }
      } else {
        const narrative = parsed as ReturnType<typeof validateQuarterlyNarrativeOutput>;
        const latest = await tx.reviewNarrativeVersion.aggregate({
          where: { reviewId: attempt.reviewId },
          _max: { versionNo: true },
        });
        const version = await tx.reviewNarrativeVersion.create({
          data: {
            id: newId(),
            reviewId: attempt.reviewId,
            versionNo: (latest._max.versionNo ?? 0) + 1,
            origin: 'ai',
            parentVersionId: review.currentNarrativeVersionId,
            contentJson: JSON.stringify(narrative.content),
            sourceSnapshotHash: attempt.policy.sanitizedInputHash,
            aiGenerationId: generation.id,
            contentHash: requestHash(narrative.content),
            changeSummaryJson: JSON.stringify({
              kind: 'ai_narrative_suggestion',
              citations: narrative.sections.map((section) => ({
                section: section.section,
                citations: section.citations,
              })),
            }),
            createdBy: this.sessions.currentProfileId,
          },
        });
        suggestionVersionId = version.id;
        // AI 自评只形成候选版本，不改变当前人工正文指针，也不使已确认快照失效。
      }
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: `quarterly_review.ai_${attempt.purpose}_succeeded`,
        targetType: 'ai_generation',
        targetId: generation.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          reviewId: attempt.reviewId,
          reviewVersion: attempt.reviewVersion,
          suggestionVersionId,
          sanitizedInputHash: attempt.policy.sanitizedInputHash,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return {
        fallback: false,
        generation: this.serialize(generation, true, review.version),
        suggestionVersionId,
        currentNarrativeVersionId: review.currentNarrativeVersionId,
        reviewVersion: review.version,
      };
    });
  }

  private async recordFailure(
    attempt: Attempt,
    status: 'failed' | 'blocked',
    errorCode: string,
    blocks: string[],
    context: MutationContext,
    provider: {
      rawOutput?: string | null;
      protocol?: AiProviderConfig['protocol'];
      model?: string;
      requestId?: string | null;
      stopReason?: string | null;
      usage?: AiUsage;
    } = {},
  ) {
    const generation = await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiGeneration.create({
        data: {
          ...this.generationBase(attempt),
          rawOutput: provider.rawOutput ?? null,
          parsedOutputJson: null,
          protocol: provider.protocol ?? attempt.connection.config.protocol,
          model: provider.model ?? attempt.connection.config.model,
          providerRequestId: provider.requestId ?? null,
          stopReason: provider.stopReason ?? null,
          usageJson: JSON.stringify(provider.usage ?? this.emptyUsage()),
          durationMs: Date.now() - attempt.startedAt,
          status,
          errorCode,
          securityBlocksJson: JSON.stringify(blocks),
          adoptionStatus: 'not_applicable',
          completedAt: new Date(),
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: `quarterly_review.ai_${attempt.purpose}_${status}`,
        targetType: 'ai_generation',
        targetId: row.id,
        correlationId: context.correlationId,
        outcome: status === 'blocked' ? 'rejected' : 'failed',
        after: { reviewId: attempt.reviewId, errorCode, blocks },
        errorCode,
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return row;
    });
    let fallbackNarrative = null;
    if (attempt.purpose === 'quarterly_review') {
      const current = await this.prisma.quarterlyReview.findUniqueOrThrow({
        where: { id: attempt.reviewId },
      });
      if (!current.currentNarrativeVersionId && current.version === attempt.reviewVersion) {
        fallbackNarrative = await this.narratives.createRuleNarrative(
          attempt.reviewId,
          { reviewVersion: current.version },
          context,
        );
      }
    }
    return {
      fallback: true,
      fallbackReasonCode: errorCode,
      fallbackNarrative,
      generation: this.serialize(generation, true, attempt.reviewVersion),
    };
  }

  private generationBase(attempt: Attempt) {
    return {
      id: attempt.id,
      ownerProfileId: this.sessions.currentProfileId,
      providerConnectionId: attempt.connection.id,
      providerConfigVersion: attempt.connection.version,
      quarterlyReviewId: attempt.reviewId,
      baseQuarterlyReviewVersion: attempt.reviewVersion,
      purpose: attempt.purpose,
      promptTemplateVersion: quarterlyAiPromptTemplateVersion,
      sanitizationPolicyVersion: quarterlyAiSanitizationPolicyVersion,
      retentionMode: 'hash_only',
      requestedFieldsJson: JSON.stringify(
        attempt.purpose === 'score_suggestion'
          ? attempt.policy.metrics.map((metric) => metric.id)
          : [
              'overallOverview',
              'coreAchievements',
              'collaborationAndGrowth',
              'problemsAndImprovements',
              'nextPeriodPlan',
            ],
      ),
      inputRefsJson: JSON.stringify(attempt.policy.storedReferences),
      inputCategoriesJson: JSON.stringify(attempt.policy.inputCategories),
      removedCategoriesJson: JSON.stringify(attempt.policy.removedCategories),
      sanitizedInputHash: attempt.policy.sanitizedInputHash,
      sanitizedInputJson: null,
      createdBy: this.sessions.currentProfileId,
    };
  }

  private async loadFacts(reviewId: string): Promise<{
    metrics: QuarterlyAiMetric[];
    achievements: QuarterlyAiAchievement[];
  }> {
    const review = await this.prisma.quarterlyReview.findUniqueOrThrow({ where: { id: reviewId } });
    const [metrics, achievements] = await Promise.all([
      review.metricTemplateVersionId
        ? this.prisma.performanceMetric.findMany({
            where: { templateVersionId: review.metricTemplateVersionId, enabled: true },
            orderBy: { sortOrder: 'asc' },
          })
        : [],
      this.prisma.achievement.findMany({
        where: { reviewId, selectionStatus: 'selected' },
        include: {
          project: true,
          evidences: { orderBy: [{ primaryEvidence: 'desc' }, { createdAt: 'asc' }] },
          metricLinks: { where: { active: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      metrics: metrics.map((metric) => ({
        id: metric.id,
        code: metric.code,
        name: metric.name,
        definition: metric.definition,
        minimum: metric.minimum,
        maximum: metric.maximum,
        step: metric.step,
        required: metric.required,
      })),
      achievements: achievements.map((achievement) => ({
        id: achievement.id,
        projectName: achievement.project?.name ?? null,
        title: achievement.title,
        situation: achievement.situation,
        action: achievement.action,
        result: achievement.result,
        impact: achievement.impact,
        contributionBoundary: achievement.contributionBoundary,
        periodStart: achievement.periodStart,
        periodEnd: achievement.periodEnd,
        metricIds: achievement.metricLinks.map((link) => link.metricId),
        evidences: achievement.evidences,
      })),
    };
  }

  private async resolveConnection(connectionId: string, purpose: AiPurpose) {
    const row = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, type: 'ai', enabled: true },
    });
    if (!row)
      throw new DomainError('AI_CONNECTION_NOT_FOUND', 'AI 连接不存在或已停用', {
        httpStatus: 404,
      });
    if (row.status !== 'healthy')
      throw new DomainError('AI_CONNECTION_NOT_HEALTHY', 'AI 连接尚未通过真实连接测试', {
        httpStatus: 422,
      });
    if (!row.baseUrl || !row.credentialRef)
      throw new DomainError('AI_CONNECTION_INCOMPLETE', 'AI 连接缺少地址或凭证', {
        httpStatus: 422,
      });
    const config = aiProviderConfigSchema.parse(JSON.parse(row.configJson) as unknown);
    if (!config.allowedPurposes.includes(purpose)) {
      throw new DomainError('AI_PURPOSE_NOT_ALLOWED', 'AI 连接未允许该季度生成用途', {
        httpStatus: 403,
      });
    }
    return {
      id: row.id,
      version: row.version,
      baseUrl: row.baseUrl,
      credentialRef: row.credentialRef,
      config,
    };
  }

  private serialize(
    row: {
      id: string;
      quarterlyReviewId: string | null;
      baseQuarterlyReviewVersion: number | null;
      providerConnectionId: string;
      providerConfigVersion: number;
      purpose: string;
      promptTemplateVersion: string;
      sanitizationPolicyVersion: string;
      retentionMode: string;
      requestedFieldsJson: string;
      inputRefsJson: string;
      inputCategoriesJson: string;
      removedCategoriesJson: string;
      sanitizedInputHash: string | null;
      rawOutput: string | null;
      parsedOutputJson: string | null;
      protocol: string;
      model: string;
      providerRequestId: string | null;
      stopReason: string | null;
      usageJson: string;
      durationMs: number | null;
      status: string;
      errorCode: string | null;
      securityBlocksJson: string;
      adoptionStatus: string;
      decisionReason: string | null;
      decidedAt: Date | null;
      createdAt: Date;
      completedAt: Date | null;
    },
    detailed: boolean,
    currentReviewVersion: number,
  ) {
    return {
      id: row.id,
      reviewId: row.quarterlyReviewId,
      baseReviewVersion: row.baseQuarterlyReviewVersion,
      providerConnectionId: row.providerConnectionId,
      providerConfigVersion: row.providerConfigVersion,
      purpose: row.purpose,
      promptTemplateVersion: row.promptTemplateVersion,
      sanitizationPolicyVersion: row.sanitizationPolicyVersion,
      retentionMode: row.retentionMode,
      requestedFields: this.parse(row.requestedFieldsJson, []),
      inputCategories: this.parse(row.inputCategoriesJson, []),
      removedCategories: this.parse(row.removedCategoriesJson, []),
      sanitizedInputHash: row.sanitizedInputHash,
      protocol: row.protocol,
      model: row.model,
      providerRequestId: row.providerRequestId,
      stopReason: row.stopReason,
      usage: this.parse(row.usageJson, {}),
      durationMs: row.durationMs,
      status: row.status,
      errorCode: row.errorCode,
      securityBlocks: this.parse(row.securityBlocksJson, []),
      adoptionStatus: row.adoptionStatus,
      decisionReason: row.decisionReason,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      stale: row.baseQuarterlyReviewVersion !== currentReviewVersion,
      ...(detailed
        ? {
            inputRefs: this.parse(row.inputRefsJson, []),
            rawOutput: row.rawOutput,
            parsedOutput: row.parsedOutputJson ? this.parse(row.parsedOutputJson, null) : null,
          }
        : {}),
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private async assertOwnedReview(reviewId: string) {
    const row = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!row) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
  }

  private errorCode(error: unknown, fallback: string) {
    return error instanceof DomainError ? error.code : fallback;
  }

  private securityCategories(error: unknown): string[] {
    if (!(error instanceof DomainError) || !this.isObject(error.options.details))
      return ['provider_output'];
    const categories = error.options.details.categories;
    return Array.isArray(categories)
      ? categories.filter((item): item is string => typeof item === 'string').slice(0, 50)
      : ['provider_output'];
  }

  private emptyUsage(): AiUsage {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  }

  private parse<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private versionConflict(expectedVersion: number): never {
    throw new DomainError(errorCodes.versionConflict, '季度评审已被其他页面修改，请刷新后重试', {
      httpStatus: 409,
      details: { expectedVersion },
      suggestedAction: 'refresh',
    });
  }
}
