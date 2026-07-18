import { describe, expect, it } from 'vitest';
import {
  calculatePerformanceScores,
  resolveCustomPerformancePeriod,
  resolveNaturalQuarter,
} from '../src/lib/quarterly-performance.js';

describe('季度周期与绩效分数领域规则', () => {
  it('自然季度使用闭区间展示和下一季度半开边界', () => {
    expect(resolveNaturalQuarter(2026, 2)).toEqual({
      name: '2026 Q2',
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      nextPeriodStart: '2026-07-01',
      timezone: 'Asia/Shanghai',
      naturalQuarter: true,
      year: 2026,
      quarter: 2,
    });
    expect(resolveNaturalQuarter(2026, 4)).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-12-31',
      nextPeriodStart: '2027-01-01',
    });
  });

  it('自定义周期验证真实日期、有序范围和最大跨度', () => {
    expect(
      resolveCustomPerformancePeriod({
        name: ' 年度特别考核 ',
        periodStart: '2026-02-01',
        periodEnd: '2026-03-15',
      }),
    ).toMatchObject({
      name: '年度特别考核',
      nextPeriodStart: '2026-03-16',
      naturalQuarter: false,
    });
    expect(() =>
      resolveCustomPerformancePeriod({
        name: '无效日期',
        periodStart: '2026-02-30',
        periodEnd: '2026-03-15',
      }),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_DATE_INVALID' }));
  });

  it('不同用户分按未舍入贡献计算后再按模板取整', () => {
    const result = calculatePerformanceScores({
      metrics: [
        metric('delivery', '业务交付', 40, 1),
        metric('quality', '质量稳定', 35, 2),
        metric('growth', '协作成长', 25, 3),
      ],
      scores: [
        { metricId: 'delivery', userScore: 4.5, reason: '交付证据充分' },
        { metricId: 'quality', userScore: 4, reason: '缺陷率可核对' },
        { metricId: 'growth', userScore: 3.5, reason: '完成评审与分享' },
      ],
      formulaType: 'weighted_average_100',
      roundingRule: 'half_up_1_decimal',
    });
    expect(result.lines.map((line) => line.rawContribution)).toEqual([1.8, 1.4, 0.875]);
    expect(result.rawTotal).toBeCloseTo(4.075);
    expect(result.finalTotal).toBe(4.1);
    expect(result.formulaText).toBe('Σ(用户分 × 权重 ÷ 100)');
  });

  it('权重、步长、必填分和理由均为不可绕过门禁', () => {
    expect(() =>
      calculatePerformanceScores({
        metrics: [metric('a', '指标 A', 60, 1), metric('b', '指标 B', 30, 2)],
        scores: [],
        formulaType: 'weighted_average_100',
        roundingRule: 'none',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PERFORMANCE_WEIGHT_TOTAL_INVALID' }));
    expect(() =>
      calculatePerformanceScores({
        metrics: [metric('a', '指标 A', 100, 1)],
        scores: [{ metricId: 'a', userScore: 4.3, reason: '不符合 0.5 步长' }],
        formulaType: 'weighted_average_100',
        roundingRule: 'none',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PERFORMANCE_SCORE_RANGE_INVALID' }));
  });
});

function metric(id: string, name: string, weight: number, order: number) {
  return {
    id,
    name,
    weight,
    minimum: 1,
    maximum: 5,
    step: 0.5,
    required: true,
    enabled: true,
    order,
  };
}
