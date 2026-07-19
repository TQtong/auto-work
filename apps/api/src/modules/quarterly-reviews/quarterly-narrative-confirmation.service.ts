import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import {
  calculatePerformanceScores,
  newId,
  requestHash,
  type PerformanceMetricDefinition,
  type QuarterlyFormulaType,
  type QuarterlyRoundingRule,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { QuarterlyCompletenessService } from './quarterly-completeness.service.js';
import {
  buildRuleNarrative,
  type QuarterlyAiAchievement,
  type QuarterlyNarrativeContent,
} from './quarterly-review-ai.policy.js';

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

interface IdempotentMutationContext extends MutationContext {
  idempotencyRecordId: string;
}

interface FrozenFacts {
  review: {
    id: string;
    name: string;
    periodStart: string;
    periodEnd: string;
    timezone: string;
    version: number;
    currentNarrativeVersionId: string | null;
  };
  achievements: unknown[];
  template: {
    id: string;
    versionNo: number;
    formulaType: string;
    roundingRule: string;
    contentHash: string;
    metrics: Array<PerformanceMetricDefinition & { code: string; definition: string }>;
  } | null;
  scores: Array<{
    metricId: string;
    userScore: number | null;
    userReason: string | null;
    rawContribution: number | null;
    validationStatus: string;
    aiSuggestedScore: number | null;
    aiSuggestedMinimum: number | null;
    aiSuggestedMaximum: number | null;
    aiReason: string | null;
    aiEvidenceGaps: unknown[];
    aiUncertainty: string | null;
    aiGenerationId: string | null;
  }>;
  narrative: {
    id: string;
    versionNo: number;
    origin: string;
    content: QuarterlyNarrativeContent;
  } | null;
  completeness: Record<string, unknown>;
}

@Injectable()
export class QuarterlyNarrativeConfirmationService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly completeness: QuarterlyCompletenessService,
  ) {}

  public async listNarratives(reviewId: string) {
    await this.ownedReview(reviewId);
    const rows = await this.prisma.reviewNarrativeVersion.findMany({
      where: { reviewId },
      orderBy: { versionNo: 'desc' },
      take: 200,
    });
    return rows.map((row) => this.serializeNarrative(row, false));
  }

  public async getNarrative(reviewId: string, versionId: string) {
    const row = await this.prisma.reviewNarrativeVersion.findFirst({
      where: {
        id: versionId,
        reviewId,
        review: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
    });
    if (!row) throw new DomainError(errorCodes.notFound, '自评版本不存在', { httpStatus: 404 });
    return this.serializeNarrative(row, true);
  }

  public async createRuleNarrative(
    reviewId: string,
    input: { reviewVersion: number },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      const achievements = await this.selectedAchievements(tx, reviewId);
      if (achievements.length === 0) {
        throw new DomainError(
          'QUARTERLY_NARRATIVE_ACHIEVEMENT_REQUIRED',
          '至少选择一项成果后才能生成规则自评',
          {
            httpStatus: 422,
          },
        );
      }
      const content = buildRuleNarrative(review.name, this.toAiAchievements(achievements));
      return this.createVersion(
        tx,
        review,
        'rule',
        content,
        null,
        {
          kind: 'rule_narrative_generated',
        },
        context,
        true,
      );
    });
  }

  public async createManualNarrative(
    reviewId: string,
    input: {
      reviewVersion: number;
      parentVersionId: string | null;
      content: QuarterlyNarrativeContent;
      changeReason: string;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      await this.validateContentReferences(tx, review, input.content);
      if (input.parentVersionId) await this.assertNarrative(tx, reviewId, input.parentVersionId);
      return this.createVersion(
        tx,
        review,
        'manual',
        input.content,
        input.parentVersionId,
        { kind: 'manual_edit', reason: input.changeReason },
        context,
        true,
      );
    });
  }

  public async restoreNarrative(
    reviewId: string,
    versionId: string,
    input: { reviewVersion: number; changeReason: string },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      const source = await this.assertNarrative(tx, reviewId, versionId);
      const content = this.parseNarrative(source.contentJson);
      await this.validateContentReferences(tx, review, content);
      // 恢复操作创建新的人工版本，历史版本自身始终不可变。
      return this.createVersion(
        tx,
        review,
        'manual',
        content,
        versionId,
        { kind: 'historical_version_restored', reason: input.changeReason },
        context,
        true,
      );
    });
  }

  public async adoptAiNarrative(
    reviewId: string,
    generationId: string,
    input: { reviewVersion: number; decisionReason: string },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      const generation = await tx.aiGeneration.findFirst({
        where: {
          id: generationId,
          quarterlyReviewId: reviewId,
          purpose: 'quarterly_review',
          ownerProfileId: this.sessions.currentProfileId,
        },
      });
      if (!generation)
        throw new DomainError(errorCodes.notFound, 'AI 自评建议不存在', { httpStatus: 404 });
      if (generation.adoptionStatus === 'adopted') {
        const adopted = await tx.reviewNarrativeVersion.findFirstOrThrow({
          where: { aiGenerationId: generation.id, origin: 'manual' },
          orderBy: { versionNo: 'desc' },
        });
        return {
          replayed: true,
          narrative: this.serializeNarrative(adopted, true),
          reviewVersion: review.version,
        };
      }
      if (generation.status !== 'succeeded' || generation.adoptionStatus !== 'pending') {
        throw new DomainError('QUARTERLY_AI_DECISION_FINAL', '该 AI 建议不可采纳', {
          httpStatus: 409,
        });
      }
      const suggestion = await tx.reviewNarrativeVersion.findFirst({
        where: { reviewId, aiGenerationId: generation.id, origin: 'ai' },
      });
      if (!suggestion)
        throw new DomainError('QUARTERLY_AI_NARRATIVE_MISSING', 'AI 自评建议版本缺失', {
          httpStatus: 409,
        });
      const result = await this.createVersion(
        tx,
        review,
        'manual',
        this.parseNarrative(suggestion.contentJson),
        suggestion.id,
        { kind: 'ai_narrative_adopted', generationId, reason: input.decisionReason },
        context,
        true,
        generation.id,
      );
      await tx.aiGeneration.update({
        where: { id: generation.id },
        data: {
          adoptionStatus: 'adopted',
          adoptedNarrativeVersionId: result.narrative.id,
          decisionReason: input.decisionReason,
          decidedAt: new Date(),
        },
      });
      return { ...result, replayed: false };
    });
  }

  public async rejectAi(
    reviewId: string,
    generationId: string,
    input: { decisionReason: string },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const generation = await tx.aiGeneration.findFirst({
        where: {
          id: generationId,
          quarterlyReviewId: reviewId,
          ownerProfileId: this.sessions.currentProfileId,
        },
      });
      if (!generation)
        throw new DomainError(errorCodes.notFound, 'AI 建议不存在', { httpStatus: 404 });
      if (generation.adoptionStatus === 'rejected') return { replayed: true, generationId };
      if (generation.adoptionStatus !== 'pending') {
        throw new DomainError('QUARTERLY_AI_DECISION_FINAL', 'AI 建议已经完成决策', {
          httpStatus: 409,
        });
      }
      await tx.aiGeneration.update({
        where: { id: generation.id },
        data: {
          adoptionStatus: 'rejected',
          decisionReason: input.decisionReason,
          decidedAt: new Date(),
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.ai_suggestion_rejected',
        targetType: 'ai_generation',
        targetId: generation.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { decisionReason: input.decisionReason },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { replayed: false, generationId };
    });
  }

  public async preflight(reviewId: string, narrativeVersionId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const facts = await this.frozenFacts(tx, reviewId, narrativeVersionId);
      return this.buildPreflight(facts);
    });
  }

  public async confirm(
    reviewId: string,
    input: {
      reviewVersion: number;
      narrativeVersionId: string;
      acknowledgements: Array<{ code: string; reason: string }>;
    },
    context: IdempotentMutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      });
      if (!review)
        throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
      if (review.currentConfirmationId) {
        const active = await tx.quarterlyReviewConfirmation.findUnique({
          where: { id: review.currentConfirmationId },
        });
        if (
          active?.status === 'active' &&
          active.narrativeVersionId === input.narrativeVersionId &&
          active.reviewVersion === input.reviewVersion
        ) {
          const response = {
            replayed: true,
            confirmation: this.serializeConfirmation(active, true),
            reviewVersion: review.version,
          };
          // 业务层安全重放也必须冻结到本次 HTTP 幂等账本，避免后续重试悬挂在 processing。
          await this.completeIdempotency(tx, context.idempotencyRecordId, response);
          return response;
        }
      }
      if (review.version !== input.reviewVersion) this.versionConflict(review.version);
      if (review.currentNarrativeVersionId !== input.narrativeVersionId) {
        throw new DomainError('QUARTERLY_CURRENT_NARRATIVE_REQUIRED', '只能确认当前自评正文版本', {
          httpStatus: 422,
          details: { currentNarrativeVersionId: review.currentNarrativeVersionId },
        });
      }
      const facts = await this.frozenFacts(tx, reviewId, input.narrativeVersionId);
      const preflight = this.buildPreflight(facts);
      if (!preflight.confirmable) {
        throw new DomainError('QUARTERLY_CONFIRMATION_BLOCKED', '季度绩效尚不满足确认条件', {
          httpStatus: 422,
          details: {
            blockers: preflight.blockers,
            requiredAcknowledgements: preflight.requiredAcknowledgements,
          },
        });
      }
      const acknowledgementByCode = new Map(
        input.acknowledgements.map((item) => [item.code, item]),
      );
      const missing = preflight.requiredAcknowledgements.filter(
        (item) => !acknowledgementByCode.has(item.code),
      );
      if (missing.length > 0) {
        throw new DomainError('QUARTERLY_COMPLETENESS_ACK_REQUIRED', '必须逐项知悉材料完整性风险', {
          httpStatus: 422,
          details: { missing: missing.map((item) => item.code) },
        });
      }
      const calculation = this.calculate(facts);
      const achievementsHash = requestHash(facts.achievements);
      const scoresHash = requestHash(facts.scores);
      const acknowledgementSnapshot = preflight.requiredAcknowledgements.map((item) => ({
        ...item,
        reason: acknowledgementByCode.get(item.code)!.reason,
        acknowledgedBy: this.sessions.currentProfileId,
        acknowledgedAt: new Date().toISOString(),
      }));
      const snapshot = {
        review: facts.review,
        achievements: facts.achievements,
        template: facts.template,
        scores: facts.scores,
        calculation,
        narrative: facts.narrative,
        completeness: facts.completeness,
        acknowledgements: acknowledgementSnapshot,
      };
      const confirmation = await tx.quarterlyReviewConfirmation.create({
        data: {
          id: newId(),
          reviewId,
          reviewVersion: review.version,
          metricTemplateVersionId: facts.template!.id,
          narrativeVersionId: facts.narrative!.id,
          snapshotHash: requestHash(snapshot),
          achievementsHash,
          scoresHash,
          calculationJson: JSON.stringify(calculation),
          reviewSnapshotJson: JSON.stringify(facts.review),
          achievementsSnapshotJson: JSON.stringify(facts.achievements),
          scoresSnapshotJson: JSON.stringify(facts.scores),
          templateSnapshotJson: JSON.stringify(facts.template),
          narrativeSnapshotJson: JSON.stringify(facts.narrative),
          completenessSnapshotJson: JSON.stringify(facts.completeness),
          completenessAckJson: JSON.stringify(acknowledgementSnapshot),
          confirmedBy: this.sessions.currentProfileId,
        },
      });
      const changed = await tx.quarterlyReview.updateMany({
        where: {
          id: reviewId,
          version: review.version,
          currentNarrativeVersionId: input.narrativeVersionId,
        },
        data: {
          currentConfirmationId: confirmation.id,
          status: 'confirmed',
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.versionConflict(review.version);
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.confirmed',
        targetType: 'quarterly_review_confirmation',
        targetId: confirmation.id,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          reviewId,
          snapshotHash: confirmation.snapshotHash,
          finalTotal: calculation.finalTotal,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      const response = {
        replayed: false,
        confirmation: this.serializeConfirmation(confirmation, true),
        reviewVersion: review.version + 1,
      };
      // 确认快照、聚合版本、审计事件和响应账本同事务提交，杜绝“业务成功但无法重放”。
      await this.completeIdempotency(tx, context.idempotencyRecordId, response);
      return response;
    });
  }

  public async listConfirmations(reviewId: string) {
    await this.ownedReview(reviewId);
    const rows = await this.prisma.quarterlyReviewConfirmation.findMany({
      where: { reviewId },
      orderBy: { confirmedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => this.serializeConfirmation(row, false));
  }

  public async getConfirmation(reviewId: string, confirmationId: string) {
    const row = await this.prisma.quarterlyReviewConfirmation.findFirst({
      where: {
        id: confirmationId,
        reviewId,
        review: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
    });
    if (!row) throw new DomainError(errorCodes.notFound, '季度确认快照不存在', { httpStatus: 404 });
    return this.serializeConfirmation(row, true);
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    recordId: string,
    response: unknown,
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { id: recordId },
      data: {
        state: 'completed',
        httpStatus: 201,
        responseJson: JSON.stringify(response),
        errorCode: null,
      },
    });
  }

  private async createVersion(
    tx: Prisma.TransactionClient,
    review: { id: string; version: number; currentConfirmationId: string | null },
    origin: 'rule' | 'manual' | 'ai',
    content: QuarterlyNarrativeContent,
    parentVersionId: string | null,
    changeSummary: Record<string, unknown>,
    context: MutationContext,
    makeCurrent: boolean,
    aiGenerationId: string | null = null,
  ) {
    const latest = await tx.reviewNarrativeVersion.aggregate({
      where: { reviewId: review.id },
      _max: { versionNo: true },
    });
    const sourceSnapshotHash = await this.sourceSnapshotHash(tx, review.id);
    const version = await tx.reviewNarrativeVersion.create({
      data: {
        id: newId(),
        reviewId: review.id,
        versionNo: (latest._max.versionNo ?? 0) + 1,
        origin,
        parentVersionId,
        contentJson: JSON.stringify(content),
        sourceSnapshotHash,
        aiGenerationId,
        contentHash: requestHash(content),
        changeSummaryJson: JSON.stringify(changeSummary),
        createdBy: this.sessions.currentProfileId,
      },
    });
    let reviewVersion = review.version;
    if (makeCurrent) {
      await this.invalidateConfirmation(
        tx,
        review.currentConfirmationId,
        '季度自评正文版本发生变化',
      );
      const changed = await tx.quarterlyReview.updateMany({
        where: { id: review.id, version: review.version },
        data: {
          currentNarrativeVersionId: version.id,
          currentConfirmationId: null,
          status: 'narrative_ready',
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.versionConflict(review.version);
      reviewVersion += 1;
    }
    await this.audit.recordInTransaction(tx, {
      actorId: this.sessions.currentProfileId,
      action: `quarterly_review.narrative_${origin}_created`,
      targetType: 'review_narrative_version',
      targetId: version.id,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after: {
        reviewId: review.id,
        versionNo: version.versionNo,
        contentHash: version.contentHash,
        makeCurrent,
      },
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
    return { narrative: this.serializeNarrative(version, true), reviewVersion };
  }

  private async frozenFacts(
    tx: Prisma.TransactionClient,
    reviewId: string,
    narrativeVersionId?: string,
  ): Promise<FrozenFacts> {
    const review = await tx.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    const achievements = await this.selectedAchievements(tx, reviewId);
    const template = review.metricTemplateVersionId
      ? await tx.performanceMetricTemplateVersion.findUnique({
          where: { id: review.metricTemplateVersionId },
          include: { metrics: { orderBy: { sortOrder: 'asc' } } },
        })
      : null;
    const scores = await tx.scoreItem.findMany({
      where: { reviewId },
      orderBy: { metric: { sortOrder: 'asc' } },
    });
    const selectedNarrativeId = narrativeVersionId ?? review.currentNarrativeVersionId;
    const narrative = selectedNarrativeId
      ? await tx.reviewNarrativeVersion.findFirst({ where: { id: selectedNarrativeId, reviewId } })
      : null;
    const completeness = await this.completeness.calculate(tx, reviewId);
    return {
      review: {
        id: review.id,
        name: review.name,
        periodStart: review.periodStart,
        periodEnd: review.periodEnd,
        timezone: review.timezone,
        version: review.version,
        currentNarrativeVersionId: review.currentNarrativeVersionId,
      },
      achievements: achievements.map((achievement) => ({
        id: achievement.id,
        projectId: achievement.projectId,
        projectName: achievement.project?.name ?? null,
        title: achievement.title,
        situation: achievement.situation,
        action: achievement.action,
        result: achievement.result,
        impact: achievement.impact,
        contributionBoundary: achievement.contributionBoundary,
        periodStart: achievement.periodStart,
        periodEnd: achievement.periodEnd,
        evidences: achievement.evidences.map((evidence) => ({
          id: evidence.id,
          sourceType: evidence.sourceType,
          sourceId: evidence.sourceId,
          title: evidence.title,
          externalKey: evidence.externalKey,
          eventAt: evidence.eventAt?.toISOString() ?? null,
          url: evidence.url,
          availabilityState: evidence.availabilityState,
          sourceContentHash: evidence.sourceContentHash,
          sourceSummary: this.parse(evidence.sourceSummaryJson, {}),
          contributionAngle: evidence.contributionAngle,
          primaryEvidence: evidence.primaryEvidence,
        })),
        metricLinks: achievement.metricLinks.map((link) => ({
          id: link.id,
          metricId: link.metricId,
          contribution: link.contribution,
          version: link.version,
        })),
      })),
      template: template
        ? {
            id: template.id,
            versionNo: template.versionNo,
            formulaType: template.formulaType,
            roundingRule: template.roundingRule,
            contentHash: template.contentHash,
            metrics: template.metrics.map((metric) => ({
              id: metric.id,
              code: metric.code,
              name: metric.name,
              definition: metric.definition,
              weight: metric.weight,
              minimum: metric.minimum,
              maximum: metric.maximum,
              step: metric.step,
              required: metric.required,
              enabled: metric.enabled,
              order: metric.sortOrder,
              evidenceRequirement: this.parse(metric.evidenceRequirementJson, {}),
            })),
          }
        : null,
      scores: scores.map((score) => ({
        metricId: score.metricId,
        userScore: score.userScore,
        userReason: score.userReason,
        rawContribution: score.rawContribution,
        validationStatus: score.validationStatus,
        aiSuggestedScore: score.aiSuggestedScore,
        aiSuggestedMinimum: score.aiSuggestedMinimum,
        aiSuggestedMaximum: score.aiSuggestedMaximum,
        aiReason: score.aiReason,
        aiEvidenceGaps: this.parse(score.aiEvidenceGapsJson, []),
        aiUncertainty: score.aiUncertainty,
        aiGenerationId: score.aiGenerationId,
      })),
      narrative: narrative
        ? {
            id: narrative.id,
            versionNo: narrative.versionNo,
            origin: narrative.origin,
            content: this.parseNarrative(narrative.contentJson),
          }
        : null,
      completeness,
    };
  }

  private buildPreflight(facts: FrozenFacts) {
    const blockers: Array<{ code: string; message: string }> = [];
    if (facts.achievements.length === 0)
      blockers.push({ code: 'SELECTED_ACHIEVEMENT_REQUIRED', message: '至少选择一项成果' });
    if (!facts.template)
      blockers.push({ code: 'METRIC_TEMPLATE_REQUIRED', message: '必须绑定指标模板版本' });
    if (!facts.narrative)
      blockers.push({ code: 'NARRATIVE_REQUIRED', message: '必须准备自评正文' });
    if (facts.narrative && facts.narrative.id !== facts.review.currentNarrativeVersionId) {
      blockers.push({ code: 'CURRENT_NARRATIVE_REQUIRED', message: '只能确认当前自评正文版本' });
    }
    const scoreByMetric = new Map(facts.scores.map((score) => [score.metricId, score]));
    for (const metric of facts.template?.metrics ?? []) {
      if (!metric.enabled || !metric.required) continue;
      const score = scoreByMetric.get(metric.id);
      if (score?.userScore == null || !score.userReason?.trim()) {
        blockers.push({
          code: 'REQUIRED_SCORE_MISSING',
          message: `必填指标“${metric.name}”缺少用户评分或理由`,
        });
      }
    }
    const acknowledgementDefinitions: Array<[string, string, string]> = [
      ['selectedWithoutEvidenceCount', 'SELECTED_WITHOUT_EVIDENCE', '已选成果缺少证据'],
      ['selectedWithoutMetricCount', 'SELECTED_WITHOUT_METRIC', '已选成果尚未映射指标'],
      ['requiredMetricUncoveredCount', 'REQUIRED_METRIC_UNCOVERED', '必填指标缺少成果覆盖'],
      ['duplicateEvidenceReferenceCount', 'DUPLICATE_EVIDENCE_REFERENCE', '同一证据被多项成果引用'],
    ];
    const requiredAcknowledgements = acknowledgementDefinitions.flatMap(
      ([field, code, message]) => {
        const count = Number(facts.completeness[field] ?? 0);
        return count > 0 ? [{ code, message, count }] : [];
      },
    );
    const sourceFreshness =
      typeof facts.completeness.sourceFreshness === 'string'
        ? facts.completeness.sourceFreshness
        : 'not_collected';
    if (!['fresh', 'not_applicable'].includes(sourceFreshness)) {
      requiredAcknowledgements.push({
        code: 'SOURCE_FRESHNESS_RISK',
        message: '来源未达到新鲜状态',
        count: 1,
      });
    }
    return {
      confirmable: blockers.length === 0,
      blockers,
      requiredAcknowledgements,
      completeness: facts.completeness,
    };
  }

  private calculate(facts: FrozenFacts) {
    if (!facts.template)
      throw new DomainError('PERFORMANCE_TEMPLATE_REQUIRED', '请先绑定指标模板', {
        httpStatus: 422,
      });
    return calculatePerformanceScores({
      metrics: facts.template.metrics,
      scores: facts.template.metrics.map((metric) => ({
        metricId: metric.id,
        userScore: facts.scores.find((score) => score.metricId === metric.id)?.userScore ?? null,
        reason: facts.scores.find((score) => score.metricId === metric.id)?.userReason ?? null,
      })),
      formulaType: facts.template.formulaType as QuarterlyFormulaType,
      roundingRule: facts.template.roundingRule as QuarterlyRoundingRule,
    });
  }

  private async selectedAchievements(tx: Prisma.TransactionClient, reviewId: string) {
    return tx.achievement.findMany({
      where: { reviewId, selectionStatus: 'selected' },
      include: {
        project: true,
        evidences: { orderBy: [{ primaryEvidence: 'desc' }, { createdAt: 'asc' }] },
        metricLinks: { where: { active: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private toAiAchievements(
    rows: Awaited<ReturnType<QuarterlyNarrativeConfirmationService['selectedAchievements']>>,
  ): QuarterlyAiAchievement[] {
    return rows.map((row) => ({
      id: row.id,
      projectName: row.project?.name ?? null,
      title: row.title,
      situation: row.situation,
      action: row.action,
      result: row.result,
      impact: row.impact,
      contributionBoundary: row.contributionBoundary,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      metricIds: row.metricLinks.map((link) => link.metricId),
      evidences: row.evidences,
    }));
  }

  private async validateContentReferences(
    tx: Prisma.TransactionClient,
    review: { id: string; metricTemplateVersionId: string | null },
    content: QuarterlyNarrativeContent,
  ) {
    const achievements = await this.selectedAchievements(tx, review.id);
    const achievementIds = new Set(achievements.map((item) => item.id));
    const evidenceIds = new Set(
      achievements.flatMap((item) => item.evidences.map((evidence) => evidence.id)),
    );
    const metricIds = new Set(
      achievements.flatMap((item) => item.metricLinks.map((link) => link.metricId)),
    );
    for (const section of content.coreAchievements) {
      if (section.achievementIds.some((id) => !achievementIds.has(id))) {
        throw new DomainError(
          'NARRATIVE_ACHIEVEMENT_REFERENCE_INVALID',
          '自评引用了未选择或不属于本评审的成果',
          { httpStatus: 422 },
        );
      }
      if (section.evidenceIds.some((id) => !evidenceIds.has(id))) {
        throw new DomainError(
          'NARRATIVE_EVIDENCE_REFERENCE_INVALID',
          '自评引用了不属于已选成果的证据',
          { httpStatus: 422 },
        );
      }
      if (section.metricIds.some((id) => !metricIds.has(id))) {
        throw new DomainError(
          'NARRATIVE_METRIC_REFERENCE_INVALID',
          '自评引用了未激活的成果指标映射',
          { httpStatus: 422 },
        );
      }
    }
  }

  private async sourceSnapshotHash(
    tx: Prisma.TransactionClient,
    reviewId: string,
  ): Promise<string> {
    const facts = await this.selectedAchievements(tx, reviewId);
    return requestHash(
      facts.map((item) => ({
        id: item.id,
        version: item.version,
        evidence: item.evidences.map((evidence) => evidence.sourceContentHash),
        metricLinks: item.metricLinks.map((link) => `${link.id}:${link.version}`),
      })),
    );
  }

  private async reviewForMutation(tx: Prisma.TransactionClient, reviewId: string, version: number) {
    const review = await tx.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    if (review.version !== version) this.versionConflict(review.version);
    return review;
  }

  private async ownedReview(reviewId: string) {
    const review = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    return review;
  }

  private async assertNarrative(tx: Prisma.TransactionClient, reviewId: string, versionId: string) {
    const row = await tx.reviewNarrativeVersion.findFirst({ where: { id: versionId, reviewId } });
    if (!row) throw new DomainError(errorCodes.notFound, '自评版本不存在', { httpStatus: 404 });
    return row;
  }

  private async invalidateConfirmation(
    tx: Prisma.TransactionClient,
    confirmationId: string | null,
    reason: string,
  ) {
    if (!confirmationId) return;
    await tx.quarterlyReviewConfirmation.updateMany({
      where: { id: confirmationId, status: 'active' },
      data: { status: 'invalidated', invalidatedAt: new Date(), invalidationReason: reason },
    });
  }

  private serializeNarrative(
    row: {
      id: string;
      reviewId: string;
      versionNo: number;
      origin: string;
      parentVersionId: string | null;
      contentJson: string;
      sourceSnapshotHash: string;
      aiGenerationId: string | null;
      contentHash: string;
      changeSummaryJson: string;
      createdBy: string;
      createdAt: Date;
    },
    detailed: boolean,
  ) {
    return {
      id: row.id,
      reviewId: row.reviewId,
      versionNo: row.versionNo,
      origin: row.origin,
      parentVersionId: row.parentVersionId,
      sourceSnapshotHash: row.sourceSnapshotHash,
      aiGenerationId: row.aiGenerationId,
      contentHash: row.contentHash,
      changeSummary: this.parse(row.changeSummaryJson, {}),
      ...(detailed ? { content: this.parseNarrative(row.contentJson) } : {}),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private serializeConfirmation(
    row: {
      id: string;
      reviewId: string;
      reviewVersion: number;
      metricTemplateVersionId: string;
      narrativeVersionId: string;
      snapshotHash: string;
      achievementsHash: string;
      scoresHash: string;
      calculationJson: string;
      reviewSnapshotJson: string;
      achievementsSnapshotJson: string;
      scoresSnapshotJson: string;
      templateSnapshotJson: string;
      narrativeSnapshotJson: string;
      completenessSnapshotJson: string;
      completenessAckJson: string;
      status: string;
      confirmedBy: string;
      confirmedAt: Date;
      invalidatedAt: Date | null;
      invalidationReason: string | null;
    },
    detailed: boolean,
  ) {
    return {
      id: row.id,
      reviewId: row.reviewId,
      reviewVersion: row.reviewVersion,
      metricTemplateVersionId: row.metricTemplateVersionId,
      narrativeVersionId: row.narrativeVersionId,
      snapshotHash: row.snapshotHash,
      achievementsHash: row.achievementsHash,
      scoresHash: row.scoresHash,
      calculation: this.parse(row.calculationJson, {}),
      acknowledgements: this.parse(row.completenessAckJson, []),
      status: row.status,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt.toISOString(),
      invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
      invalidationReason: row.invalidationReason,
      ...(detailed
        ? {
            achievementsSnapshot: this.parse(row.achievementsSnapshotJson, []),
            reviewSnapshot: this.parse(row.reviewSnapshotJson, {}),
            scoresSnapshot: this.parse(row.scoresSnapshotJson, []),
            templateSnapshot: this.parse(row.templateSnapshotJson, {}),
            narrativeSnapshot: this.parse(row.narrativeSnapshotJson, {}),
            completenessSnapshot: this.parse(row.completenessSnapshotJson, {}),
          }
        : {}),
    };
  }

  private parseNarrative(value: string): QuarterlyNarrativeContent {
    return this.parse(value, {} as QuarterlyNarrativeContent);
  }

  private parse<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private versionConflict(expectedVersion: number): never {
    throw new DomainError(errorCodes.versionConflict, '季度评审已被其他页面修改，请刷新后重试', {
      httpStatus: 409,
      details: { expectedVersion },
      suggestedAction: 'refresh',
    });
  }
}
