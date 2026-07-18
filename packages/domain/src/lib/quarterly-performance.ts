import { DomainError } from '@auto-work/contracts';

export type QuarterlyFormulaType = 'weighted_average_100' | 'weighted_sum' | 'simple_sum';
export type QuarterlyRoundingRule =
  'none' | 'half_up_integer' | 'half_up_1_decimal' | 'floor_integer' | 'ceil_integer';

export interface QuarterlyPeriod {
  name: string;
  periodStart: string;
  periodEnd: string;
  nextPeriodStart: string;
  timezone: 'Asia/Shanghai';
  naturalQuarter: boolean;
  year: number | null;
  quarter: 1 | 2 | 3 | 4 | null;
}

export interface PerformanceMetricDefinition {
  id: string;
  name: string;
  weight: number;
  minimum: number;
  maximum: number;
  step: number;
  required: boolean;
  enabled: boolean;
  order: number;
}

export interface PerformanceScoreInput {
  metricId: string;
  userScore: number | null;
  reason: string | null;
}

export interface PerformanceScoreCalculation {
  formulaType: QuarterlyFormulaType;
  roundingRule: QuarterlyRoundingRule;
  lines: Array<{
    metricId: string;
    metricName: string;
    weight: number;
    userScore: number;
    rawContribution: number;
  }>;
  rawTotal: number;
  finalTotal: number;
  formulaText: string;
}

export function resolveNaturalQuarter(year: number, quarter: 1 | 2 | 3 | 4): QuarterlyPeriod {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new DomainError('QUARTERLY_YEAR_INVALID', '季度年份必须位于 2000 到 2100', {
      httpStatus: 422,
    });
  }
  const startMonth = (quarter - 1) * 3 + 1;
  const nextYear = quarter === 4 ? year + 1 : year;
  const nextMonth = quarter === 4 ? 1 : startMonth + 3;
  const periodStart = `${year}-${pad(startMonth)}-01`;
  const nextPeriodStart = `${nextYear}-${pad(nextMonth)}-01`;
  return {
    name: `${year} Q${quarter}`,
    periodStart,
    periodEnd: dayBefore(nextPeriodStart),
    nextPeriodStart,
    timezone: 'Asia/Shanghai',
    naturalQuarter: true,
    year,
    quarter,
  };
}

export function resolveCustomPerformancePeriod(input: {
  name: string;
  periodStart: string;
  periodEnd: string;
}): QuarterlyPeriod {
  const name = input.name.trim().normalize('NFKC');
  if (name.length < 2 || name.length > 100) {
    throw new DomainError(
      'QUARTERLY_PERIOD_NAME_INVALID',
      '自定义考核周期名称长度必须为 2 到 100',
      {
        httpStatus: 422,
      },
    );
  }
  assertDate(input.periodStart, '开始日期');
  assertDate(input.periodEnd, '结束日期');
  if (input.periodStart > input.periodEnd) {
    throw new DomainError('QUARTERLY_PERIOD_RANGE_INVALID', '考核周期开始日期不能晚于结束日期', {
      httpStatus: 422,
    });
  }
  const days = Math.round(
    (Date.parse(`${input.periodEnd}T00:00:00.000Z`) -
      Date.parse(`${input.periodStart}T00:00:00.000Z`)) /
      86_400_000,
  );
  if (days > 366) {
    throw new DomainError('QUARTERLY_PERIOD_TOO_LONG', '单个考核周期不能超过 367 个自然日', {
      httpStatus: 422,
    });
  }
  return {
    name,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    nextPeriodStart: dayAfter(input.periodEnd),
    timezone: 'Asia/Shanghai',
    naturalQuarter: false,
    year: null,
    quarter: null,
  };
}

/**
 * 分数计算只接受版本化模板声明的三种公式，不执行自由文本表达式。
 * AI 建议完全不进入此函数，最终总分只能来自逐项用户分。
 */
export function calculatePerformanceScores(input: {
  metrics: PerformanceMetricDefinition[];
  scores: PerformanceScoreInput[];
  formulaType: QuarterlyFormulaType;
  roundingRule: QuarterlyRoundingRule;
}): PerformanceScoreCalculation {
  const metrics = input.metrics
    .filter((metric) => metric.enabled)
    .sort((a, b) => a.order - b.order);
  if (metrics.length === 0) {
    throw new DomainError('PERFORMANCE_METRICS_REQUIRED', '至少需要一个启用的绩效指标', {
      httpStatus: 422,
    });
  }
  if (new Set(metrics.map((metric) => metric.id)).size !== metrics.length) {
    throw new DomainError('PERFORMANCE_METRIC_DUPLICATED', '绩效指标 ID 不得重复', {
      httpStatus: 422,
    });
  }
  const weightTotal = metrics.reduce((total, metric) => total + metric.weight, 0);
  if (input.formulaType === 'weighted_average_100' && !nearlyEqual(weightTotal, 100)) {
    throw new DomainError(
      'PERFORMANCE_WEIGHT_TOTAL_INVALID',
      '加权平均指标权重合计必须精确为 100%',
      {
        httpStatus: 422,
        details: { weightTotal },
      },
    );
  }
  const scoreMap = new Map(input.scores.map((score) => [score.metricId, score]));
  if (scoreMap.size !== input.scores.length) {
    throw new DomainError('PERFORMANCE_SCORE_DUPLICATED', '同一指标只能提交一项用户分', {
      httpStatus: 422,
    });
  }
  const lines = metrics.flatMap((metric) => {
    assertMetric(metric);
    const score = scoreMap.get(metric.id);
    if (score?.userScore === null || score?.userScore === undefined) {
      if (metric.required) {
        throw new DomainError(
          'PERFORMANCE_REQUIRED_SCORE_MISSING',
          `必填指标“${metric.name}”尚未评分`,
          {
            httpStatus: 422,
            details: { metricId: metric.id },
          },
        );
      }
      return [];
    }
    if (!score.reason?.trim()) {
      throw new DomainError(
        'PERFORMANCE_SCORE_REASON_REQUIRED',
        `指标“${metric.name}”必须填写评分理由`,
        {
          httpStatus: 422,
          details: { metricId: metric.id },
        },
      );
    }
    if (
      score.userScore < metric.minimum ||
      score.userScore > metric.maximum ||
      !onStep(score.userScore, metric.minimum, metric.step)
    ) {
      throw new DomainError(
        'PERFORMANCE_SCORE_RANGE_INVALID',
        `指标“${metric.name}”分数必须在 ${metric.minimum}～${metric.maximum} 且符合步长 ${metric.step}`,
        { httpStatus: 422, details: { metricId: metric.id, userScore: score.userScore } },
      );
    }
    const rawContribution =
      input.formulaType === 'weighted_average_100'
        ? (score.userScore * metric.weight) / 100
        : input.formulaType === 'weighted_sum'
          ? score.userScore * metric.weight
          : score.userScore;
    return [
      {
        metricId: metric.id,
        metricName: metric.name,
        weight: metric.weight,
        userScore: score.userScore,
        rawContribution,
      },
    ];
  });
  const rawTotal = lines.reduce((total, line) => total + line.rawContribution, 0);
  const finalTotal = roundScore(rawTotal, input.roundingRule);
  return {
    formulaType: input.formulaType,
    roundingRule: input.roundingRule,
    lines,
    rawTotal,
    finalTotal,
    formulaText:
      input.formulaType === 'weighted_average_100'
        ? 'Σ(用户分 × 权重 ÷ 100)'
        : input.formulaType === 'weighted_sum'
          ? 'Σ(用户分 × 权重)'
          : 'Σ(用户分)',
  };
}

function assertMetric(metric: PerformanceMetricDefinition): void {
  if (
    !metric.name.trim() ||
    !Number.isFinite(metric.weight) ||
    metric.weight < 0 ||
    !Number.isFinite(metric.minimum) ||
    !Number.isFinite(metric.maximum) ||
    metric.minimum > metric.maximum ||
    !Number.isFinite(metric.step) ||
    metric.step <= 0
  ) {
    throw new DomainError(
      'PERFORMANCE_METRIC_INVALID',
      `绩效指标“${metric.name || metric.id}”配置无效`,
      {
        httpStatus: 422,
        details: { metricId: metric.id },
      },
    );
  }
}

function roundScore(value: number, rule: QuarterlyRoundingRule): number {
  if (rule === 'none') return value;
  if (rule === 'half_up_1_decimal') return Math.round((value + Number.EPSILON) * 10) / 10;
  if (rule === 'floor_integer') return Math.floor(value);
  if (rule === 'ceil_integer') return Math.ceil(value);
  return Math.round(value + Number.EPSILON);
}

function onStep(value: number, minimum: number, step: number): boolean {
  return nearlyEqual((value - minimum) / step, Math.round((value - minimum) / step));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new DomainError('QUARTERLY_DATE_INVALID', `${label}格式必须为 YYYY-MM-DD`, {
      httpStatus: 422,
    });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DomainError('QUARTERLY_DATE_INVALID', `${label}不是有效公历日期`, {
      httpStatus: 422,
    });
  }
}

function dayBefore(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

function dayAfter(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}
