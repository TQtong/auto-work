import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { newId, requestHash } from '@auto-work/domain';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { LocalSecurityService } from '../../infrastructure/http/local-security.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../session/session.service.js';
import { QuarterlyCompletenessService } from './quarterly-completeness.service.js';

interface MutationContext {
  correlationId: string;
  sessionId: string;
}

interface AchievementFields {
  projectId: string | null;
  title: string;
  situation: string;
  action: string;
  result: string;
  impact: string;
  contributionBoundary: string;
  periodStart: string;
  periodEnd: string;
}

@Injectable()
export class QuarterlyAchievementService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: LocalSecurityService,
    private readonly completeness: QuarterlyCompletenessService,
  ) {}

  public async list(
    reviewId: string,
    input: {
      status?: string | undefined;
      projectId?: string | undefined;
      sourceType?: string | undefined;
      evidenceSourceType?: string | undefined;
      evidenceStatus?: string | undefined;
      metricId?: string | undefined;
      month?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    await this.ownedReview(reviewId);
    const monthRange = input.month ? this.monthRange(input.month) : undefined;
    const rows = await this.prisma.achievement.findMany({
      where: {
        reviewId,
        ...(input.status ? { selectionStatus: input.status } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.sourceType ? { sourceType: input.sourceType } : {}),
        ...(input.evidenceSourceType
          ? { evidences: { some: { sourceType: input.evidenceSourceType } } }
          : {}),
        ...(input.evidenceStatus ? { evidenceStatus: input.evidenceStatus } : {}),
        ...(input.metricId
          ? { metricLinks: { some: { metricId: input.metricId, active: true } } }
          : {}),
        ...(monthRange
          ? { periodStart: { lte: monthRange.end }, periodEnd: { gte: monthRange.start } }
          : {}),
      },
      include: {
        project: true,
        evidences: { orderBy: [{ primaryEvidence: 'desc' }, { createdAt: 'asc' }] },
        metricLinks: {
          where: { active: true },
          include: { metric: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ selectionStatus: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const duplicateEvidence = await this.prisma.achievementEvidence.groupBy({
      by: ['sourceType', 'sourceId'],
      where: { achievement: { reviewId } },
      _count: { achievementId: true },
      having: { achievementId: { _count: { gt: 1 } } },
    });
    const duplicateKeys = new Set(
      duplicateEvidence.map((item) => `${item.sourceType}:${item.sourceId}`),
    );
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((row) => this.serialize(row, duplicateKeys));
    return {
      items,
      page: {
        cursor: input.cursor,
        nextCursor: hasMore ? items.at(-1)?.id : undefined,
        hasMore,
        limit: input.limit,
      },
    };
  }

  public async createManual(
    reviewId: string,
    input: AchievementFields & { reviewVersion: number },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      await this.assertProject(tx, input.projectId);
      this.assertPeriod(review, input);
      await this.invalidateConfirmation(tx, review, '新增人工季度成果');
      const achievement = await tx.achievement.create({
        data: {
          id: newId(),
          reviewId,
          projectId: input.projectId,
          sourceType: 'manual',
          sourceKey: `manual:${newId()}`,
          title: input.title,
          situation: input.situation,
          action: input.action,
          result: input.result,
          impact: input.impact,
          contributionBoundary: input.contributionBoundary,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          selectionStatus: 'needs_evidence',
          evidenceStatus: 'needs_evidence',
          createdBy: this.sessions.currentProfileId,
        },
      });
      const updated = await this.bumpReview(tx, reviewId, 'selecting', review.version);
      await this.record(tx, context, 'quarterly_achievement.manual_created', achievement.id, {
        reviewId,
        projectId: input.projectId,
        contentHash: requestHash(input),
      });
      return {
        achievementId: achievement.id,
        achievementVersion: achievement.version,
        reviewVersion: updated.version,
      };
    });
  }

  public async update(
    achievementId: string,
    input: AchievementFields & { reviewVersion: number; version: number; changeReason: string },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const achievement = await this.achievementForMutation(tx, achievementId, input.version);
      const review = await this.reviewForMutation(tx, achievement.reviewId, input.reviewVersion);
      await this.assertProject(tx, input.projectId);
      this.assertPeriod(review, input);
      await this.invalidateConfirmation(tx, review, '季度成果结构化内容发生变化');
      const changed = await tx.achievement.updateMany({
        where: { id: achievementId, version: input.version },
        data: {
          projectId: input.projectId,
          title: input.title,
          situation: input.situation,
          action: input.action,
          result: input.result,
          impact: input.impact,
          contributionBoundary: input.contributionBoundary,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.versionConflict('季度成果已被其他页面修改');
      const updated = await this.bumpReview(tx, review.id, 'selecting', review.version);
      await this.record(tx, context, 'quarterly_achievement.updated', achievementId, {
        reviewId: review.id,
        changeReason: input.changeReason,
        contentHash: requestHash(input),
      });
      return {
        achievementId,
        achievementVersion: input.version + 1,
        reviewVersion: updated.version,
      };
    });
  }

  public async updateSelection(
    reviewId: string,
    input: {
      reviewVersion: number;
      actions: Array<{
        achievementId: string;
        version: number;
        status: string;
        reason: string;
        sortOrder: number;
      }>;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.reviewForMutation(tx, reviewId, input.reviewVersion);
      const rows = await tx.achievement.findMany({
        where: { id: { in: input.actions.map((action) => action.achievementId) }, reviewId },
      });
      if (rows.length !== input.actions.length) {
        throw new DomainError(
          'QUARTERLY_ACHIEVEMENT_SCOPE_INVALID',
          '选择动作包含不属于当前评审的成果',
          {
            httpStatus: 422,
          },
        );
      }
      for (const action of input.actions) {
        const current = rows.find((row) => row.id === action.achievementId)!;
        if (current.version !== action.version) this.versionConflict('季度成果已被修改');
        const changed = await tx.achievement.updateMany({
          where: { id: action.achievementId, version: action.version },
          data: {
            selectionStatus: action.status,
            exclusionReason: action.status === 'excluded' ? action.reason : null,
            sortOrder: action.sortOrder,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) this.versionConflict('季度成果已被其他页面修改');
      }
      await this.invalidateConfirmation(tx, review, '季度成果选择或排序发生变化');
      const updated = await this.bumpReview(tx, reviewId, 'selecting', review.version);
      await this.record(tx, context, 'quarterly_achievement.selection_updated', reviewId, {
        actions: input.actions.map((action) => ({
          achievementId: action.achievementId,
          status: action.status,
          reasonHash: requestHash(action.reason),
          sortOrder: action.sortOrder,
        })),
      });
      return { reviewId, reviewVersion: updated.version, updatedCount: input.actions.length };
    });
  }

  public async addEvidence(
    achievementId: string,
    input: {
      reviewVersion: number;
      achievementVersion: number;
      sourceType: 'manual_link';
      title: string;
      externalKey: string | null;
      url: string | null;
      eventAt: string | null;
      availabilityState: string;
      summary: Record<string, unknown>;
      contributionAngle: string;
      primaryEvidence: boolean;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const achievement = await this.achievementForMutation(
        tx,
        achievementId,
        input.achievementVersion,
      );
      const review = await this.reviewForMutation(tx, achievement.reviewId, input.reviewVersion);
      if (input.eventAt) {
        const eventAt = new Date(input.eventAt);
        const periodStart = new Date(`${review.periodStart}T00:00:00.000+08:00`);
        const nextPeriodStart = new Date(`${review.nextPeriodStart}T00:00:00.000+08:00`);
        if (eventAt < periodStart || eventAt >= nextPeriodStart) {
          throw new DomainError(
            'ACHIEVEMENT_EVIDENCE_PERIOD_INVALID',
            '证据发生时间必须位于当前考核周期内',
            { httpStatus: 422 },
          );
        }
      }
      const sourceId = requestHash({
        sourceType: input.sourceType,
        externalKey: input.externalKey,
        url: input.url,
        title: input.title,
      });
      const [duplicate, currentPrimary] = await Promise.all([
        tx.achievementEvidence.findUnique({
          where: {
            achievementId_sourceType_sourceId: {
              achievementId,
              sourceType: input.sourceType,
              sourceId,
            },
          },
          select: { id: true },
        }),
        input.primaryEvidence
          ? tx.achievementEvidence.findFirst({
              where: { achievementId, primaryEvidence: true },
              select: { id: true },
            })
          : Promise.resolve(null),
      ]);
      if (duplicate) {
        throw new DomainError('ACHIEVEMENT_EVIDENCE_DUPLICATE', '当前成果已经引用同一人工证据', {
          httpStatus: 409,
        });
      }
      if (currentPrimary) {
        throw new DomainError(
          'ACHIEVEMENT_PRIMARY_EVIDENCE_EXISTS',
          '当前成果已经有主证据，请将新证据标记为辅助证据',
          { httpStatus: 409 },
        );
      }
      await this.invalidateConfirmation(tx, review, '季度成果证据发生变化');
      const evidence = await tx.achievementEvidence.create({
        data: {
          id: newId(),
          achievementId,
          sourceType: input.sourceType,
          // 人工链接使用稳定来源键；同一链接支持多个成果时才能被重复引用检查识别。
          sourceId,
          title: input.title,
          externalKey: input.externalKey,
          url: input.url,
          eventAt: input.eventAt ? new Date(input.eventAt) : null,
          availabilityState: input.availabilityState,
          sourceContentHash: requestHash({
            title: input.title,
            externalKey: input.externalKey,
            url: input.url,
            eventAt: input.eventAt,
            summary: input.summary,
          }),
          sourceSummaryJson: JSON.stringify(input.summary),
          contributionAngle: input.contributionAngle,
          primaryEvidence: input.primaryEvidence,
        },
      });
      const changed = await tx.achievement.updateMany({
        where: { id: achievementId, version: input.achievementVersion },
        data: {
          evidenceStatus:
            input.availabilityState === 'available'
              ? 'complete'
              : achievement.evidenceStatus === 'needs_evidence'
                ? 'partial'
                : achievement.evidenceStatus,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) this.versionConflict('季度成果已被其他页面修改');
      const updated = await this.bumpReview(tx, review.id, 'selecting', review.version);
      await this.record(tx, context, 'quarterly_achievement.evidence_added', evidence.id, {
        reviewId: review.id,
        achievementId,
        sourceType: input.sourceType,
        sourceContentHash: evidence.sourceContentHash,
      });
      return {
        evidenceId: evidence.id,
        achievementVersion: input.achievementVersion + 1,
        reviewVersion: updated.version,
      };
    });
  }

  public async updateMetrics(
    achievementId: string,
    input: {
      reviewVersion: number;
      achievementVersion: number;
      links: Array<{ metricId: string; contribution: string }>;
    },
    context: MutationContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const achievement = await this.achievementForMutation(
        tx,
        achievementId,
        input.achievementVersion,
      );
      const review = await this.reviewForMutation(tx, achievement.reviewId, input.reviewVersion);
      if (achievement.selectionStatus !== 'selected') {
        throw new DomainError(
          'ACHIEVEMENT_NOT_SELECTED',
          '只有已选成果可以映射绩效指标，请先在候选池完成选择',
          { httpStatus: 422 },
        );
      }
      if (!review.metricTemplateVersionId) {
        throw new DomainError('PERFORMANCE_TEMPLATE_REQUIRED', '请先绑定指标模板版本', {
          httpStatus: 422,
        });
      }
      const metrics = await tx.performanceMetric.findMany({
        where: { templateVersionId: review.metricTemplateVersionId },
      });
      const allowed = new Set(metrics.map((metric) => metric.id));
      if (input.links.some((link) => !allowed.has(link.metricId))) {
        throw new DomainError('ACHIEVEMENT_METRIC_SCOPE_INVALID', '映射包含不属于当前模板的指标', {
          httpStatus: 422,
        });
      }
      const active = await tx.achievementMetricLink.findMany({
        where: { achievementId, active: true },
      });
      const now = new Date();
      await tx.achievementMetricLink.updateMany({
        where: { achievementId, active: true },
        data: { active: false, supersededAt: now },
      });
      for (const link of input.links) {
        const previousVersions = await tx.achievementMetricLink.findMany({
          where: { achievementId, metricId: link.metricId },
          orderBy: { version: 'desc' },
          take: 1,
        });
        await tx.achievementMetricLink.create({
          data: {
            id: newId(),
            achievementId,
            metricId: link.metricId,
            contribution: link.contribution,
            version: (previousVersions[0]?.version ?? 0) + 1,
            createdBy: this.sessions.currentProfileId,
          },
        });
      }
      await this.invalidateConfirmation(tx, review, '成果指标映射发生变化');
      const changed = await tx.achievement.updateMany({
        where: { id: achievementId, version: input.achievementVersion },
        data: { version: { increment: 1 } },
      });
      if (changed.count !== 1) this.versionConflict('季度成果已被其他页面修改');
      const updated = await this.bumpReview(tx, review.id, 'scoring', review.version);
      await this.record(tx, context, 'quarterly_achievement.metrics_updated', achievementId, {
        reviewId: review.id,
        previousMetricIds: active.map((link) => link.metricId),
        links: input.links.map((link) => ({
          metricId: link.metricId,
          contributionHash: requestHash(link.contribution),
        })),
      });
      return {
        achievementId,
        achievementVersion: input.achievementVersion + 1,
        reviewVersion: updated.version,
        activeLinkCount: input.links.length,
      };
    });
  }

  private async ownedReview(reviewId: string) {
    const review = await this.prisma.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      select: { id: true },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
  }

  private async reviewForMutation(
    tx: Prisma.TransactionClient,
    reviewId: string,
    expectedVersion: number | undefined,
  ) {
    const review = await tx.quarterlyReview.findFirst({
      where: { id: reviewId, ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
    });
    if (!review) throw new DomainError(errorCodes.notFound, '季度评审不存在', { httpStatus: 404 });
    if (expectedVersion !== undefined && review.version !== expectedVersion) {
      this.versionConflict('季度评审已被其他页面修改');
    }
    return review;
  }

  private async achievementForMutation(
    tx: Prisma.TransactionClient,
    achievementId: string,
    expectedVersion: number,
  ) {
    const achievement = await tx.achievement.findFirst({
      where: {
        id: achievementId,
        review: { ownerProfileId: this.sessions.currentProfileId, archivedAt: null },
      },
    });
    if (!achievement)
      throw new DomainError(errorCodes.notFound, '季度成果不存在', { httpStatus: 404 });
    if (achievement.version !== expectedVersion) this.versionConflict('季度成果已被其他页面修改');
    return achievement;
  }

  private async assertProject(
    tx: Prisma.TransactionClient,
    projectId: string | null,
  ): Promise<void> {
    if (!projectId) return;
    const project = await tx.project.findFirst({
      where: { id: projectId, enabled: true, archivedAt: null },
    });
    if (!project)
      throw new DomainError(errorCodes.notFound, '项目不存在或已归档', { httpStatus: 404 });
  }

  private assertPeriod(
    review: { periodStart: string; periodEnd: string },
    fields: { periodStart: string; periodEnd: string },
  ): void {
    if (
      fields.periodStart > fields.periodEnd ||
      fields.periodStart < review.periodStart ||
      fields.periodEnd > review.periodEnd
    ) {
      throw new DomainError('ACHIEVEMENT_PERIOD_INVALID', '成果日期必须有序且位于考核周期内', {
        httpStatus: 422,
      });
    }
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

  private bumpReview(
    tx: Prisma.TransactionClient,
    reviewId: string,
    status: string,
    expectedVersion: number,
  ) {
    return this.bumpReviewWithCompleteness(tx, reviewId, status, expectedVersion);
  }

  private async bumpReviewWithCompleteness(
    tx: Prisma.TransactionClient,
    reviewId: string,
    status: string,
    expectedVersion: number,
  ) {
    const completeness = await this.completeness.calculate(tx, reviewId);
    const changed = await tx.quarterlyReview.updateMany({
      where: { id: reviewId, version: expectedVersion },
      data: {
        status,
        currentConfirmationId: null,
        completenessJson: JSON.stringify(completeness),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) this.versionConflict('季度评审已被其他页面修改');
    return tx.quarterlyReview.findUniqueOrThrow({ where: { id: reviewId } });
  }

  private versionConflict(message: string): never {
    throw new DomainError(errorCodes.versionConflict, message, {
      httpStatus: 409,
      suggestedAction: 'refresh',
    });
  }

  private record(
    tx: Prisma.TransactionClient,
    context: MutationContext,
    action: string,
    targetId: string,
    after: unknown,
  ) {
    return this.audit.recordInTransaction(tx, {
      actorId: this.sessions.currentProfileId,
      action,
      targetType: 'quarterly_achievement',
      targetId,
      correlationId: context.correlationId,
      outcome: 'succeeded',
      after,
      clientSessionHash: this.security.sessionHash(context.sessionId),
    });
  }

  private serialize(
    row: Prisma.AchievementGetPayload<{
      include: {
        project: true;
        evidences: true;
        metricLinks: { include: { metric: true } };
      };
    }>,
    duplicateKeys: Set<string>,
  ) {
    return {
      id: row.id,
      reviewId: row.reviewId,
      project: row.project ? { id: row.project.id, name: row.project.name } : null,
      sourceType: row.sourceType,
      sourceKey: row.sourceKey,
      title: row.title,
      situation: row.situation,
      action: row.action,
      result: row.result,
      impact: row.impact,
      contributionBoundary: row.contributionBoundary,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      selectionStatus: row.selectionStatus,
      exclusionReason: row.exclusionReason,
      evidenceStatus: row.evidenceStatus,
      sortOrder: row.sortOrder,
      version: row.version,
      evidences: row.evidences.map((evidence) => ({
        id: evidence.id,
        sourceType: evidence.sourceType,
        sourceId: evidence.sourceId,
        title: evidence.title,
        externalKey: evidence.externalKey,
        url: evidence.url,
        eventAt: evidence.eventAt?.toISOString() ?? null,
        availabilityState: evidence.availabilityState,
        sourceContentHash: evidence.sourceContentHash,
        sourceSummary: this.parse(evidence.sourceSummaryJson),
        contributionAngle: evidence.contributionAngle,
        primaryEvidence: evidence.primaryEvidence,
        duplicateInReview: duplicateKeys.has(`${evidence.sourceType}:${evidence.sourceId}`),
      })),
      metricLinks: row.metricLinks.map((link) => ({
        id: link.id,
        metricId: link.metricId,
        metricCode: link.metric.code,
        metricName: link.metric.name,
        contribution: link.contribution,
        version: link.version,
      })),
      warnings: [
        ...(row.evidences.some((evidence) =>
          duplicateKeys.has(`${evidence.sourceType}:${evidence.sourceId}`),
        )
          ? ['DUPLICATE_EVIDENCE_REFERENCE']
          : []),
        ...(row.selectionStatus === 'selected' && row.evidences.length === 0
          ? ['SELECTED_WITHOUT_EVIDENCE']
          : []),
        ...(row.selectionStatus === 'selected' && row.metricLinks.length === 0
          ? ['SELECTED_WITHOUT_METRIC']
          : []),
      ],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private parse(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private monthRange(month: string): { start: string; end: string } {
    const [yearText, monthText] = month.split('-');
    const year = Number(yearText);
    const monthIndex = Number(monthText);
    // 使用 UTC 只为稳定计算公历月末，不参与业务时区边界换算。
    const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
    return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
  }
}
