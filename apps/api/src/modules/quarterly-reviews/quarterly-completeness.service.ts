import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * 材料完整性只描述来源、证据、映射和评分理由是否齐备，绝不参与绩效总分公式。
 * 该服务由所有季度写路径复用，避免页面看到已经过期的检查结果。
 */
@Injectable()
export class QuarterlyCompletenessService {
  public async calculate(
    tx: Prisma.TransactionClient,
    reviewId: string,
    options: { metricTemplateVersionId?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const [review, selected] = await Promise.all([
      tx.quarterlyReview.findUniqueOrThrow({
        where: { id: reviewId },
        include: { scores: true },
      }),
      tx.achievement.findMany({
        where: { reviewId, selectionStatus: 'selected' },
        include: {
          evidences: { select: { sourceType: true, sourceId: true } },
          metricLinks: { where: { active: true }, select: { metricId: true } },
        },
      }),
    ]);
    const templateVersionId =
      options.metricTemplateVersionId === undefined
        ? review.metricTemplateVersionId
        : options.metricTemplateVersionId;
    const requiredMetrics = templateVersionId
      ? await tx.performanceMetric.findMany({
          where: { templateVersionId, enabled: true, required: true },
          select: { id: true },
        })
      : [];
    const evidenceUses = new Map<string, number>();
    for (const achievement of selected) {
      for (const evidence of achievement.evidences) {
        const key = `${evidence.sourceType}:${evidence.sourceId}`;
        evidenceUses.set(key, (evidenceUses.get(key) ?? 0) + 1);
      }
    }
    const coveredMetricIds = new Set(
      selected.flatMap((achievement) => achievement.metricLinks.map((link) => link.metricId)),
    );
    const requiredMetricIds = new Set(requiredMetrics.map((metric) => metric.id));
    const coveredRequiredMetricCount = [...requiredMetricIds].filter((metricId) =>
      coveredMetricIds.has(metricId),
    ).length;
    const scoredRequiredMetricCount = new Set(
      review.scores
        .filter(
          (score) =>
            requiredMetricIds.has(score.metricId) &&
            score.userScore !== null &&
            Boolean(score.userReason?.trim()),
        )
        .map((score) => score.metricId),
    ).size;
    const selectedWithoutEvidenceCount = selected.filter(
      (achievement) => achievement.evidences.length === 0,
    ).length;
    const selectedWithoutMetricCount = selected.filter(
      (achievement) => achievement.metricLinks.length === 0,
    ).length;
    const duplicateEvidenceReferenceCount = [...evidenceUses.values()].filter(
      (count) => count > 1,
    ).length;
    return {
      ...this.parse(review.completenessJson),
      evidenceCoverage:
        selected.length === 0
          ? 0
          : (selected.length - selectedWithoutEvidenceCount) / selected.length,
      requiredMetricCoverage:
        requiredMetrics.length === 0 ? 0 : coveredRequiredMetricCount / requiredMetrics.length,
      scoreReasonCoverage:
        requiredMetrics.length === 0 ? 0 : scoredRequiredMetricCount / requiredMetrics.length,
      unresolvedConflictCount: duplicateEvidenceReferenceCount,
      selectedAchievementCount: selected.length,
      selectedWithoutEvidenceCount,
      selectedWithoutMetricCount,
      requiredMetricUncoveredCount: requiredMetrics.length - coveredRequiredMetricCount,
      duplicateEvidenceReferenceCount,
      // 明确隔离语义，调用方不得把这组比例或计数写入绩效计算输入。
      materialCompletenessOnly: true,
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
}
