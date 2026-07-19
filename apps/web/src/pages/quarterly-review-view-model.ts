import type {
  QuarterlyAchievement,
  QuarterlyConfirmationPreflight,
  QuarterlyExportArtifact,
  QuarterlyMetric,
  QuarterlyMetricTemplateVersion,
  QuarterlyReviewSummary,
  QuarterlyRoundingRule,
  QuarterlyScoreItem,
} from '../api/types.js';

export const quarterlyWorkflowItems = [
  '周期与数据',
  '候选池',
  '成果编辑',
  '指标映射',
  '分数',
  '自评',
  '确认与导出',
] as const;

export function quarterlyWorkflowStep(review: QuarterlyReviewSummary): number {
  // 服务端状态是事实源；当前指针进一步区分同一状态内已经完成的阶段。
  if (review.currentConfirmationId || review.status === 'confirmed' || review.status === 'exported')
    return 6;
  if (review.currentNarrativeVersionId || review.status === 'narrative_ready') return 5;
  if (review.status === 'scoring') return 4;
  if (review.metricTemplateVersionId) return 3;
  if (review.status === 'selecting') return 2;
  if (review.status === 'candidates_ready') return 1;
  return 0;
}

export interface QuarterlyScorePreviewLine {
  metric: QuarterlyMetric;
  userScore: number | null;
  userReason: string | null;
  rawContribution: number | null;
  valid: boolean;
  issue: string | null;
}

export interface QuarterlyScorePreview {
  lines: QuarterlyScorePreviewLine[];
  formulaText: string;
  roundingText: string;
  weightTotal: number;
  rawTotal: number;
  finalTotal: number | null;
  complete: boolean;
  warnings: string[];
}

export function buildQuarterlyScorePreview(
  template: QuarterlyMetricTemplateVersion,
  scores: QuarterlyScoreItem[],
): QuarterlyScorePreview {
  const scoreByMetric = new Map(scores.map((score) => [score.metricId, score]));
  const metrics = template.metrics
    .filter((metric) => metric.enabled)
    .sort((a, b) => a.order - b.order);
  const weightTotal = metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const lines = metrics.map((metric): QuarterlyScorePreviewLine => {
    const score = scoreByMetric.get(metric.id);
    const userScore = score?.userScore ?? null;
    const userReason = score?.userReason ?? null;
    if (userScore === null) {
      return {
        metric,
        userScore,
        userReason,
        rawContribution: null,
        valid: !metric.required,
        issue: metric.required ? '必填指标尚未录入用户分' : null,
      };
    }
    const onStep = nearlyEqual(
      (userScore - metric.minimum) / metric.step,
      Math.round((userScore - metric.minimum) / metric.step),
    );
    const rangeValid = userScore >= metric.minimum && userScore <= metric.maximum && onStep;
    const reasonValid = Boolean(userReason?.trim());
    return {
      metric,
      userScore,
      userReason,
      rawContribution:
        template.formulaType === 'weighted_average_100'
          ? (userScore * metric.weight) / 100
          : template.formulaType === 'weighted_sum'
            ? userScore * metric.weight
            : userScore,
      valid: rangeValid && reasonValid,
      issue: !rangeValid
        ? `用户分必须在 ${metric.minimum}～${metric.maximum} 且符合步长 ${metric.step}`
        : !reasonValid
          ? '必须填写用户评分理由'
          : null,
    };
  });
  const warnings = lines.flatMap((line) =>
    line.issue ? [`${line.metric.name}：${line.issue}`] : [],
  );
  if (template.formulaType === 'weighted_average_100' && !nearlyEqual(weightTotal, 100)) {
    warnings.unshift(`加权平均权重合计为 ${weightTotal}%，必须等于 100%`);
  }
  const rawTotal = lines.reduce((sum, line) => sum + (line.rawContribution ?? 0), 0);
  const complete = warnings.length === 0;
  return {
    lines,
    formulaText:
      template.formulaType === 'weighted_average_100'
        ? 'Σ(用户分 × 权重 ÷ 100)'
        : template.formulaType === 'weighted_sum'
          ? 'Σ(用户分 × 权重)'
          : 'Σ(用户分)',
    roundingText: roundingRuleLabel(template.roundingRule),
    weightTotal,
    rawTotal,
    finalTotal: complete ? roundScore(rawTotal, template.roundingRule) : null,
    complete,
    warnings,
  };
}

export function achievementCoverage(
  achievements: QuarterlyAchievement[],
  metrics: QuarterlyMetric[],
): {
  selectedCount: number;
  selectedWithoutEvidence: number;
  selectedWithoutMetric: number;
  requiredMetricUncovered: number;
  duplicateEvidenceReferences: number;
} {
  const selected = achievements.filter((achievement) => achievement.selectionStatus === 'selected');
  const coveredMetricIds = new Set(
    selected.flatMap((achievement) => achievement.metricLinks.map((link) => link.metricId)),
  );
  const duplicateEvidenceIds = new Set(
    selected.flatMap((achievement) =>
      achievement.evidences
        .filter((evidence) => evidence.duplicateInReview)
        .map((evidence) => `${evidence.sourceType}:${evidence.sourceId}`),
    ),
  );
  return {
    selectedCount: selected.length,
    selectedWithoutEvidence: selected.filter((achievement) => achievement.evidences.length === 0)
      .length,
    selectedWithoutMetric: selected.filter((achievement) => achievement.metricLinks.length === 0)
      .length,
    requiredMetricUncovered: metrics.filter(
      (metric) => metric.enabled && metric.required && !coveredMetricIds.has(metric.id),
    ).length,
    duplicateEvidenceReferences: duplicateEvidenceIds.size,
  };
}

export function confirmationReadiness(
  preflight: QuarterlyConfirmationPreflight,
  reasons: Record<string, string>,
): {
  ready: boolean;
  missingAcknowledgements: string[];
} {
  const missingAcknowledgements = preflight.requiredAcknowledgements
    .filter((item) => (reasons[item.code] ?? '').trim().length < 2)
    .map((item) => item.code);
  return {
    ready:
      preflight.confirmable &&
      preflight.blockers.length === 0 &&
      missingAcknowledgements.length === 0,
    missingAcknowledgements,
  };
}

export function canDownloadQuarterlyExport(artifact: QuarterlyExportArtifact): boolean {
  return (
    artifact.status === 'succeeded' &&
    artifact.qaStatus === 'passed' &&
    Boolean(artifact.fileName && artifact.contentHash && artifact.sizeBytes)
  );
}

export function formatFileSize(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function roundingRuleLabel(rule: QuarterlyRoundingRule): string {
  const labels: Record<QuarterlyRoundingRule, string> = {
    none: '不取整，保留原始计算值',
    half_up_integer: '最终总分四舍五入到整数',
    half_up_1_decimal: '最终总分四舍五入到 1 位小数',
    floor_integer: '最终总分向下取整',
    ceil_integer: '最终总分向上取整',
  };
  return labels[rule];
}

function roundScore(value: number, rule: QuarterlyRoundingRule): number {
  if (rule === 'none') return value;
  if (rule === 'half_up_1_decimal') return Math.round((value + Number.EPSILON) * 10) / 10;
  if (rule === 'floor_integer') return Math.floor(value);
  if (rule === 'ceil_integer') return Math.ceil(value);
  return Math.round(value + Number.EPSILON);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}
