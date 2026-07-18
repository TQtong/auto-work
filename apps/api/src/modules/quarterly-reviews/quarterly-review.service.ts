import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import {
  calculatePerformanceScores,
  newId,
  requestHash,
  resolveCustomPerformancePeriod,
  resolveNaturalQuarter,
  type PerformanceMetricDefinition,
  type QuarterlyFormulaType,
  type QuarterlyRoundingRule,
} from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

interface MetricInput {
  code: string;
  name: string;
  definition: string;
  weight: number;
  minimum: number;
  maximum: number;
  step: number;
  required: boolean;
  evidenceRequirement: Record<string, unknown>;
  enabled: boolean;
}

@Injectable()
export class QuarterlyReviewService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
  ) {}

  public async list(input: { status?: string | undefined; limit: number }) {
    const rows = await this.prisma.quarterlyReview.findMany({
      where: {
        ownerProfileId: this.sessions.currentProfileId,
        archivedAt: null,
        ...(input.status ? { status: input.status } : {}),
      },
      include: { _count: { select: { achievements: true, exportArtifacts: true } } },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: input.limit,
    });
    return { items: rows.map((row) => this.serializeSummary(row)), total: rows.length };
  }

  public async get(reviewId: string) {
    const review = await this.ownedReview(reviewId);
    const template = review.metricTemplateVersionId
      ? await this.prisma.performanceMetricTemplateVersion.findUnique({
          where: { id: review.metricTemplateVersionId },
          include: { template: true, metrics: { orderBy: { sortOrder: 'asc' } } },
        })
      : null;
    const scores = template
      ? await this.prisma.scoreItem.findMany({
          where: { reviewId, metricId: { in: template.metrics.map((metric) => metric.id) } },
          orderBy: { metric: { sortOrder: 'asc' } },
        })
      : [];
    return {
      ...this.serializeSummary(review),
      completeness: this.parse(review.completenessJson, {}),
      metricTemplate: template
        ? {
            id: template.template.id,
            name: template.template.name,
            versionId: template.id,
            versionNo: template.versionNo,
            formulaType: template.formulaType,
            roundingRule: template.roundingRule,
            contentHash: template.contentHash,
            metrics: template.metrics.map((metric) => this.serializeMetric(metric)),
          }
        : null,
      scores: scores.map((score) => ({
        id: score.id,
        metricId: score.metricId,
        aiSuggestedScore: score.aiSuggestedScore,
        aiSuggestedMinimum: score.aiSuggestedMinimum,
        aiSuggestedMaximum: score.aiSuggestedMaximum,
        aiReason: score.aiReason,
        aiEvidenceGaps: this.parse(score.aiEvidenceGapsJson, []),
        aiUncertainty: score.aiUncertainty,
        userScore: score.userScore,
        userReason: score.userReason,
        rawContribution: score.rawContribution,
        validationStatus: score.validationStatus,
        version: score.version,
      })),
    };
  }

  public async create(
    input:
      | { periodType: 'natural_quarter'; year: number; quarter: 1 | 2 | 3 | 4 }
      | { periodType: 'custom'; name: string; periodStart: string; periodEnd: string },
    context: MutationContext,
  ) {
    const period =
      input.periodType === 'natural_quarter'
        ? resolveNaturalQuarter(input.year, input.quarter)
        : resolveCustomPerformancePeriod(input);
    try {
      const review = await this.prisma.$transaction(async (tx) => {
        const created = await tx.quarterlyReview.create({
          data: {
            id: newId(),
            ownerProfileId: this.sessions.currentProfileId,
            ...period,
            completenessJson: JSON.stringify({
              sourceFreshness: 'not_collected',
              evidenceCoverage: 0,
              requiredMetricCoverage: 0,
              scoreReasonCoverage: 0,
              unresolvedConflictCount: 0,
            }),
          },
          include: { _count: { select: { achievements: true, exportArtifacts: true } } },
        });
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: 'quarterly_review.created',
          targetType: 'quarterly_review',
          targetId: created.id,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          after: period,
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        return created;
      });
      return this.serializeSummary(review);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError('QUARTERLY_PERIOD_CONFLICT', '同名或相同日期范围的考核周期已存在', {
          httpStatus: 409,
        });
      }
      throw error;
    }
  }

  public async createMetricTemplate(
    input: {
      name: string;
      formulaType: QuarterlyFormulaType;
      roundingRule: QuarterlyRoundingRule;
      metrics: MetricInput[];
    },
    context: MutationContext,
  ) {
    const normalized = this.normalizeMetrics(input.metrics);
    this.validateTemplate(normalized, input.formulaType, input.roundingRule);
    const contentHash = requestHash({
      formulaType: input.formulaType,
      roundingRule: input.roundingRule,
      metrics: normalized,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const templateId = newId();
        const versionId = newId();
        await tx.performanceMetricTemplate.create({
          data: {
            id: templateId,
            ownerProfileId: this.sessions.currentProfileId,
            name: input.name,
          },
        });
        const version = await tx.performanceMetricTemplateVersion.create({
          data: {
            id: versionId,
            templateId,
            versionNo: 1,
            formulaType: input.formulaType,
            roundingRule: input.roundingRule,
            contentHash,
            createdBy: this.sessions.currentProfileId,
            metrics: {
              create: normalized.map((metric) => ({
                id: metric.id,
                code: metric.code,
                name: metric.name,
                definition: metric.definition,
                weight: metric.weight,
                minimum: metric.minimum,
                maximum: metric.maximum,
                step: metric.step,
                required: metric.required,
                evidenceRequirementJson: JSON.stringify(metric.evidenceRequirement),
                sortOrder: metric.order,
                enabled: metric.enabled,
              })),
            },
          },
          include: { metrics: { orderBy: { sortOrder: 'asc' } } },
        });
        await tx.performanceMetricTemplate.update({
          where: { id: templateId },
          data: { currentVersionId: versionId, version: { increment: 1 } },
        });
        await this.audit.recordInTransaction(tx, {
          actorId: this.sessions.currentProfileId,
          action: 'performance_metric_template.created',
          targetType: 'performance_metric_template',
          targetId: templateId,
          correlationId: context.correlationId,
          outcome: 'succeeded',
          after: { versionId, contentHash, metricCount: normalized.length },
          clientSessionHash: this.security.sessionHash(context.sessionId),
        });
        return {
          id: templateId,
          name: input.name,
          versionId: version.id,
          versionNo: version.versionNo,
          formulaType: version.formulaType,
          roundingRule: version.roundingRule,
          contentHash,
          metrics: version.metrics.map((metric) => this.serializeMetric(metric)),
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DomainError('PERFORMANCE_TEMPLATE_NAME_CONFLICT', '同名指标模板已存在', {
          httpStatus: 409,
        });
      }
      throw error;
    }
  }

  public async listMetricTemplates() {
    const templates = await this.prisma.performanceMetricTemplate.findMany({
      where: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: { currentVersion: { include: { metrics: { orderBy: { sortOrder: 'asc' } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    return templates.map((template) => ({
      id: template.id,
      name: template.name,
      version: template.version,
      currentVersion: template.currentVersion
        ? {
            id: template.currentVersion.id,
            versionNo: template.currentVersion.versionNo,
            formulaType: template.currentVersion.formulaType,
            roundingRule: template.currentVersion.roundingRule,
            contentHash: template.currentVersion.contentHash,
            metrics: template.currentVersion.metrics.map((metric) => this.serializeMetric(metric)),
          }
        : null,
    }));
  }

  public async bindMetricTemplate(
    reviewId: string,
    input: { templateVersionId: string; reviewVersion: number },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      });
      if (!review)
        throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
      if (review.version !== input.reviewVersion) this.versionConflict(review.version);
      const version = await tx.performanceMetricTemplateVersion.findFirst({
        where: {
          id: input.templateVersionId,
          template: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
        },
        include: { metrics: true },
      });
      if (!version)
        throw new DomainError(errorCodes.notFound, '指标模板版本不存在', { httpStatus: 404 });
      await this.invalidateConfirmation(tx, review, '指标模板版本发生变化');
      for (const metric of version.metrics) {
        await tx.scoreItem.upsert({
          where: { reviewId_metricId: { reviewId, metricId: metric.id } },
          update: {},
          create: {
            id: newId(),
            reviewId,
            metricId: metric.id,
            updatedBy: this.sessions.currentProfileId,
          },
        });
      }
      const updated = await tx.quarterlyReview.update({
        where: { id: reviewId },
        data: {
          metricTemplateVersionId: version.id,
          status: 'scoring',
          currentConfirmationId: null,
          version: { increment: 1 },
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.metric_template_bound',
        targetType: 'quarterly_review',
        targetId: reviewId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: { templateVersionId: version.id, templateContentHash: version.contentHash },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { reviewId, templateVersionId: version.id, reviewVersion: updated.version };
    });
  }

  public async updateScores(
    reviewId: string,
    input: {
      reviewVersion: number;
      scores: Array<{ metricId: string; userScore: number | null; userReason: string | null }>;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.quarterlyReview.findFirst({
        where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      });
      if (!review)
        throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
      if (review.version !== input.reviewVersion) this.versionConflict(review.version);
      if (!review.metricTemplateVersionId) {
        throw new DomainError('PERFORMANCE_TEMPLATE_REQUIRED', '请先绑定指标模板版本', {
          httpStatus: 422,
        });
      }
      const template = await tx.performanceMetricTemplateVersion.findUniqueOrThrow({
        where: { id: review.metricTemplateVersionId },
        include: { metrics: { orderBy: { sortOrder: 'asc' } } },
      });
      const metricIds = new Set(template.metrics.map((metric) => metric.id));
      if (input.scores.some((score) => !metricIds.has(score.metricId))) {
        throw new DomainError('PERFORMANCE_SCORE_METRIC_INVALID', '评分包含不属于当前模板的指标', {
          httpStatus: 422,
        });
      }
      const existing = await tx.scoreItem.findMany({ where: { reviewId } });
      const merged = new Map(existing.map((score) => [score.metricId, score]));
      for (const score of input.scores) {
        merged.set(score.metricId, {
          ...(merged.get(score.metricId) ?? ({} as (typeof existing)[number])),
          metricId: score.metricId,
          userScore: score.userScore,
          userReason: score.userReason,
        });
      }
      const domainMetrics = template.metrics.map((metric) => this.domainMetric(metric));
      for (const score of input.scores) {
        if (score.userScore === null) continue;
        const metric = domainMetrics.find((item) => item.id === score.metricId)!;
        // 即使整张评分表尚未填完，本次写入的单项范围、步长和理由也必须立即通过领域校验。
        calculatePerformanceScores({
          metrics: [{ ...metric, weight: 1, required: true }],
          scores: [
            { metricId: score.metricId, userScore: score.userScore, reason: score.userReason },
          ],
          formulaType: 'simple_sum',
          roundingRule: 'none',
        });
      }
      const allScores = template.metrics.map((metric) => ({
        metricId: metric.id,
        userScore: merged.get(metric.id)?.userScore ?? null,
        reason: merged.get(metric.id)?.userReason ?? null,
      }));
      const requiredComplete = domainMetrics.every(
        (metric) =>
          !metric.required ||
          allScores.find((score) => score.metricId === metric.id)?.userScore != null,
      );
      const calculation = requiredComplete
        ? calculatePerformanceScores({
            metrics: domainMetrics,
            scores: allScores,
            formulaType: template.formulaType as QuarterlyFormulaType,
            roundingRule: template.roundingRule as QuarterlyRoundingRule,
          })
        : null;
      const contribution = new Map(
        allScores.flatMap((score) => {
          if (score.userScore === null) return [];
          const metric = domainMetrics.find((item) => item.id === score.metricId)!;
          const raw =
            template.formulaType === 'weighted_average_100'
              ? (score.userScore * metric.weight) / 100
              : template.formulaType === 'weighted_sum'
                ? score.userScore * metric.weight
                : score.userScore;
          return [[score.metricId, raw] as const];
        }),
      );
      for (const score of input.scores) {
        const current = existing.find((item) => item.metricId === score.metricId);
        await tx.scoreItem.upsert({
          where: { reviewId_metricId: { reviewId, metricId: score.metricId } },
          update: {
            userScore: score.userScore,
            userReason: score.userReason,
            rawContribution: contribution.get(score.metricId) ?? null,
            validationStatus: score.userScore === null ? 'missing' : 'valid',
            updatedBy: this.sessions.currentProfileId,
            version: { increment: 1 },
          },
          create: {
            id: newId(),
            reviewId,
            metricId: score.metricId,
            userScore: score.userScore,
            userReason: score.userReason,
            rawContribution: contribution.get(score.metricId) ?? null,
            validationStatus: score.userScore === null ? 'missing' : 'valid',
            updatedBy: this.sessions.currentProfileId,
            version: current?.version ?? 1,
          },
        });
      }
      await this.invalidateConfirmation(tx, review, '用户评分或理由发生变化');
      const updated = await tx.quarterlyReview.update({
        where: { id: reviewId },
        data: { status: 'scoring', currentConfirmationId: null, version: { increment: 1 } },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: this.sessions.currentProfileId,
        action: 'quarterly_review.scores_updated',
        targetType: 'quarterly_review',
        targetId: reviewId,
        correlationId: context.correlationId,
        outcome: 'succeeded',
        after: {
          metricIds: input.scores.map((score) => score.metricId),
          complete: Boolean(calculation),
          calculationHash: calculation ? requestHash(calculation) : null,
        },
        clientSessionHash: this.security.sessionHash(context.sessionId),
      });
      return { reviewId, reviewVersion: updated.version, calculation };
    });
  }

  private normalizeMetrics(metrics: MetricInput[]) {
    if (new Set(metrics.map((metric) => metric.code.toLowerCase())).size !== metrics.length) {
      throw new DomainError('PERFORMANCE_METRIC_CODE_DUPLICATED', '指标代码不得重复', {
        httpStatus: 422,
      });
    }
    return metrics.map((metric, index) => ({ ...metric, id: newId(), order: index + 1 }));
  }

  private validateTemplate(
    metrics: Array<MetricInput & { id: string; order: number }>,
    formulaType: QuarterlyFormulaType,
    roundingRule: QuarterlyRoundingRule,
  ): void {
    calculatePerformanceScores({
      metrics,
      scores: metrics.map((metric) => ({
        metricId: metric.id,
        userScore: metric.minimum,
        reason: '指标模板创建校验',
      })),
      formulaType,
      roundingRule,
    });
  }

  private domainMetric(metric: {
    id: string;
    name: string;
    weight: number;
    minimum: number;
    maximum: number;
    step: number;
    required: boolean;
    enabled: boolean;
    sortOrder: number;
  }): PerformanceMetricDefinition {
    return { ...metric, order: metric.sortOrder };
  }

  private async invalidateConfirmation(
    tx: Prisma.TransactionClient,
    review: { currentConfirmationId: string | null },
    reason: string,
  ): Promise<void> {
    if (!review.currentConfirmationId) return;
    await tx.quarterlyReviewConfirmation.updateMany({
      where: { id: review.currentConfirmationId, status: 'active' },
      data: { status: 'invalidated', invalidatedAt: new Date(), invalidationReason: reason },
    });
  }

  private versionConflict(expectedVersion: number): never {
    throw new DomainError(errorCodes.versionConflict, '季度评审已被其他页面修改，请刷新后重试', {
      httpStatus: 409,
      details: { expectedVersion },
      suggestedAction: 'refresh',
    });
  }

  private async ownedReview(reviewId: string) {
    const review = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      include: { _count: { select: { achievements: true, exportArtifacts: true } } },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    return review;
  }

  private serializeSummary(review: {
    id: string;
    name: string;
    periodStart: string;
    periodEnd: string;
    nextPeriodStart: string;
    timezone: string;
    naturalQuarter: boolean;
    year: number | null;
    quarter: number | null;
    status: string;
    metricTemplateVersionId: string | null;
    currentNarrativeVersionId: string | null;
    currentConfirmationId: string | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    _count: { achievements: number; exportArtifacts: number };
  }) {
    return {
      id: review.id,
      name: review.name,
      periodStart: review.periodStart,
      periodEnd: review.periodEnd,
      nextPeriodStart: review.nextPeriodStart,
      timezone: review.timezone,
      naturalQuarter: review.naturalQuarter,
      year: review.year,
      quarter: review.quarter,
      status: review.status,
      metricTemplateVersionId: review.metricTemplateVersionId,
      currentNarrativeVersionId: review.currentNarrativeVersionId,
      currentConfirmationId: review.currentConfirmationId,
      achievementCount: review._count.achievements,
      exportCount: review._count.exportArtifacts,
      version: review.version,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
    };
  }

  private serializeMetric(metric: {
    id: string;
    code: string;
    name: string;
    definition: string;
    weight: number;
    minimum: number;
    maximum: number;
    step: number;
    required: boolean;
    evidenceRequirementJson: string;
    sortOrder: number;
    enabled: boolean;
  }) {
    return {
      id: metric.id,
      code: metric.code,
      name: metric.name,
      definition: metric.definition,
      weight: metric.weight,
      minimum: metric.minimum,
      maximum: metric.maximum,
      step: metric.step,
      required: metric.required,
      evidenceRequirement: this.parse(metric.evidenceRequirementJson, {}),
      order: metric.sortOrder,
      enabled: metric.enabled,
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
