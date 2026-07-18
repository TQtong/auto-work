import { describe, expect, it } from 'vitest';
import {
  adoptWeeklyAiSuggestionSchema,
  createWeeklyAiSuggestionSchema,
  rejectWeeklyAiSuggestionSchema,
} from '../src/modules/weekly-reports/weekly-report.schemas.js';

describe('周报 AI 建议请求契约', () => {
  it('未显式授权条件数据时，三项同意必须全部保持关闭', () => {
    const parsed = createWeeklyAiSuggestionSchema.parse({
      baseVersionId: 'version-1',
      reportVersion: 3,
      providerConnectionId: 'provider-1',
      fields: ['recentGoals', 'weeklyWork'],
    });

    expect(parsed.consent).toEqual({
      allowPeopleNames: false,
      allowInternalUrls: false,
      allowDescriptionSummaries: false,
    });
  });

  it('拒绝重复建议栏位，避免同一栏位被重复拼接或重复计费', () => {
    const parsed = createWeeklyAiSuggestionSchema.safeParse({
      baseVersionId: 'version-1',
      reportVersion: 3,
      providerConnectionId: 'provider-1',
      fields: ['recentGoals', 'recentGoals'],
    });

    expect(parsed.success).toBe(false);
  });

  it('拒绝未声明的生成参数，防止调用方绕过白名单边界', () => {
    const parsed = createWeeklyAiSuggestionSchema.safeParse({
      baseVersionId: 'version-1',
      reportVersion: 3,
      providerConnectionId: 'provider-1',
      fields: ['recentGoals'],
      rawSource: '不允许透传的原始正文',
    });

    expect(parsed.success).toBe(false);
  });

  it('采纳必须同时提交建议版本、基线版本、聚合版本和非空人工原因', () => {
    expect(
      adoptWeeklyAiSuggestionSchema.safeParse({
        suggestionVersionId: 'suggestion-1',
        baseVersionId: 'base-1',
        reportVersion: 4,
        decisionReason: '  已逐段核对引用与事实  ',
      }),
    ).toMatchObject({
      success: true,
      data: { decisionReason: '已逐段核对引用与事实' },
    });
    expect(
      adoptWeeklyAiSuggestionSchema.safeParse({
        suggestionVersionId: 'suggestion-1',
        baseVersionId: 'base-1',
        reportVersion: 4,
        decisionReason: '   ',
      }).success,
    ).toBe(false);
  });

  it('拒绝同样必须记录非空原因且不接受额外决定字段', () => {
    expect(rejectWeeklyAiSuggestionSchema.parse({ decisionReason: '  事实表达不准确  ' })).toEqual({
      decisionReason: '事实表达不准确',
    });
    expect(
      rejectWeeklyAiSuggestionSchema.safeParse({
        decisionReason: '不采用',
        adoptionStatus: 'rejected',
      }).success,
    ).toBe(false);
  });
});
