import { describe, expect, it } from 'vitest';
import {
  sanitizeQuarterlyAiInput,
  validateQuarterlyNarrativeOutput,
  validateQuarterlyScoreOutput,
} from '../src/modules/quarterly-reviews/quarterly-review-ai.policy.js';

describe('季度绩效 AI 白名单、引用与评分边界策略', () => {
  it('只接受当前指标的逐项建议，拒绝 userScore 注入、越界分数和无依据数字', () => {
    const policy = createPolicy('score_suggestion');
    const citation = policy.storedReferences[0]!.refId;
    const valid = {
      suggestions: [
        {
          metricId: 'metric-delivery',
          suggestedScore: 4,
          suggestedMinimum: 3.5,
          suggestedMaximum: 4.5,
          reason: '成果在 2026-04-01 至 2026-06-30 完成，证据记录覆盖率为 20%。',
          evidenceGaps: ['仍需人工核对业务价值口径'],
          uncertainty: 'medium',
          citations: [citation],
        },
      ],
    };
    expect(validateQuarterlyScoreOutput(JSON.stringify(valid), policy)).toHaveLength(1);
    expect(() =>
      validateQuarterlyScoreOutput(
        JSON.stringify({ suggestions: [{ ...valid.suggestions[0], userScore: 5 }] }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_AI_SCORE_SCHEMA_INVALID' }));
    expect(() =>
      validateQuarterlyScoreOutput(
        JSON.stringify({ suggestions: [{ ...valid.suggestions[0], suggestedScore: 4.3 }] }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_AI_SCORE_RANGE_INVALID' }));
    expect(() =>
      validateQuarterlyScoreOutput(
        JSON.stringify({ suggestions: [{ ...valid.suggestions[0], reason: '虚构提升 99%。' }] }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_AI_FACT_UNSUPPORTED' }));
  });

  it('五段自评全部要求引用，未知引用和虚构日期均不能进入建议版本', () => {
    const policy = createPolicy('quarterly_review');
    const citation = policy.storedReferences[0]!.refId;
    const sections = [
      'overallOverview',
      'coreAchievements',
      'collaborationAndGrowth',
      'problemsAndImprovements',
      'nextPeriodPlan',
    ].map((section) => ({
      section,
      text:
        section === 'coreAchievements'
          ? '在 2026-06-30 完成目标并形成可核对证据。'
          : '依据已选成果整理，具体判断由用户复核。',
      citations: [citation],
    }));
    const result = validateQuarterlyNarrativeOutput(JSON.stringify({ sections }), policy);
    expect(result.content.coreAchievements[0]).toMatchObject({
      achievementIds: ['achievement-1'],
      metricIds: ['metric-delivery'],
      evidenceIds: ['evidence-1'],
    });
    expect(() =>
      validateQuarterlyNarrativeOutput(
        JSON.stringify({
          sections: sections.map((item) => ({ ...item, citations: ['qref_unknown'] })),
        }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_AI_CITATION_UNKNOWN' }));
    expect(() =>
      validateQuarterlyNarrativeOutput(
        JSON.stringify({
          sections: sections.map((item, index) =>
            index === 0 ? { ...item, text: '在 2027-01-01 完成。' } : item,
          ),
        }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUARTERLY_AI_FACT_UNSUPPORTED' }));
  });

  function createPolicy(purpose: 'quarterly_review' | 'score_suggestion') {
    return sanitizeQuarterlyAiInput({
      purpose,
      review: {
        name: '2026 Q2',
        periodStart: '2026-04-01',
        periodEnd: '2026-06-30',
        timezone: 'Asia/Shanghai',
      },
      metrics: [
        {
          id: 'metric-delivery',
          code: 'delivery',
          name: '业务交付',
          definition: '依据可核对成果评价交付质量',
          minimum: 1,
          maximum: 5,
          step: 0.5,
          required: true,
        },
      ],
      achievements: [
        {
          id: 'achievement-1',
          projectName: '自动化平台',
          title: '完成季度交付',
          situation: '周期开始于 2026-04-01。',
          action: '按计划实施并验证。',
          result: '在 2026-06-30 完成，覆盖率达到 20%。',
          impact: '形成可核对的交付结果。',
          contributionBoundary: '本人负责方案与实现，团队共同验收。',
          periodStart: '2026-04-01',
          periodEnd: '2026-06-30',
          metricIds: ['metric-delivery'],
          evidences: [
            {
              id: 'evidence-1',
              sourceType: 'manual',
              title: '验收记录',
              externalKey: null,
              eventAt: new Date('2026-06-30T08:00:00.000Z'),
              availabilityState: 'available',
              contributionAngle: '证明交付完成',
              sourceSummaryJson: JSON.stringify({ coverage: 20, secret: 'never-forwarded' }),
            },
          ],
        },
      ],
    });
  }
});
