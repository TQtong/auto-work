import { describe, expect, it } from 'vitest';
import type {
  QuarterlyAchievement,
  QuarterlyExportArtifact,
  QuarterlyMetricTemplateVersion,
  QuarterlyReviewSummary,
  QuarterlyScoreItem,
} from '../api/types.js';
import {
  achievementCoverage,
  buildQuarterlyScorePreview,
  canDownloadQuarterlyExport,
  confirmationReadiness,
  quarterlyWorkflowStep,
} from './quarterly-review-view-model.js';

describe('季度绩效工作台视图模型', () => {
  it('只使用用户分展开加权公式，AI 建议不会进入最终总分', () => {
    const template = metricTemplate();
    const scores = [score('delivery', 4.5, 1), score('quality', 3.5, 5)];
    const preview = buildQuarterlyScorePreview(template, scores);
    expect(preview.lines.map((line) => line.rawContribution)).toEqual([2.7, 1.4]);
    expect(preview.rawTotal).toBeCloseTo(4.1);
    expect(preview.finalTotal).toBe(4.1);
    expect(preview.complete).toBe(true);
  });

  it('把缺分、缺理由和错误权重明确列为阻断，不展示伪总分', () => {
    const template = metricTemplate();
    template.metrics[0]!.weight = 50;
    const preview = buildQuarterlyScorePreview(template, [score('delivery', 4, 5, '')]);
    expect(preview.complete).toBe(false);
    expect(preview.finalTotal).toBeNull();
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('权重合计'),
        expect.stringContaining('评分理由'),
        expect.stringContaining('尚未录入用户分'),
      ]),
    );
  });

  it('计算成果证据、指标覆盖和重复引用，而不把完整性当绩效分', () => {
    const first = achievement('first', 'selected');
    first.metricLinks = [
      {
        id: 'link',
        metricId: 'delivery',
        metricCode: 'delivery',
        metricName: '交付',
        contribution: '直接支撑',
        version: 1,
      },
    ];
    first.evidences = [evidence('shared', true)];
    const second = achievement('second', 'selected');
    second.evidences = [evidence('shared', true)];
    const coverage = achievementCoverage([first, second], metricTemplate().metrics);
    expect(coverage).toEqual({
      selectedCount: 2,
      selectedWithoutEvidence: 0,
      selectedWithoutMetric: 1,
      requiredMetricUncovered: 1,
      duplicateEvidenceReferences: 1,
    });
  });

  it('确认要求逐项填写知悉原因，且只有 QA 通过的成功制品可下载', () => {
    const preflight = {
      confirmable: true,
      blockers: [],
      requiredAcknowledgements: [{ code: 'SOURCE_FRESHNESS_RISK', message: '来源过期', count: 1 }],
      completeness: {},
    };
    expect(confirmationReadiness(preflight, {}).ready).toBe(false);
    expect(
      confirmationReadiness(preflight, { SOURCE_FRESHNESS_RISK: '已人工核对来源日期' }).ready,
    ).toBe(true);
    const artifact = exportArtifact();
    expect(canDownloadQuarterlyExport(artifact)).toBe(true);
    expect(canDownloadQuarterlyExport({ ...artifact, qaStatus: 'failed' })).toBe(false);
  });

  it('按服务端指针恢复刷新后的步骤，而不是依赖浏览器内存', () => {
    const review = reviewSummary();
    expect(quarterlyWorkflowStep(review)).toBe(0);
    expect(quarterlyWorkflowStep({ ...review, status: 'candidates_ready' })).toBe(1);
    expect(quarterlyWorkflowStep({ ...review, metricTemplateVersionId: 'template' })).toBe(3);
    expect(quarterlyWorkflowStep({ ...review, currentNarrativeVersionId: 'narrative' })).toBe(5);
    expect(quarterlyWorkflowStep({ ...review, currentConfirmationId: 'confirmation' })).toBe(6);
  });
});

function metricTemplate(): QuarterlyMetricTemplateVersion {
  return {
    id: 'template-v1',
    versionNo: 1,
    formulaType: 'weighted_average_100',
    roundingRule: 'half_up_1_decimal',
    contentHash: 'a'.repeat(64),
    metrics: [
      {
        id: 'delivery',
        code: 'delivery',
        name: '业务交付',
        definition: '按证据评价交付',
        weight: 60,
        minimum: 1,
        maximum: 5,
        step: 0.5,
        required: true,
        evidenceRequirement: {},
        order: 1,
        enabled: true,
      },
      {
        id: 'quality',
        code: 'quality',
        name: '工程质量',
        definition: '按证据评价质量',
        weight: 40,
        minimum: 1,
        maximum: 5,
        step: 0.5,
        required: true,
        evidenceRequirement: {},
        order: 2,
        enabled: true,
      },
    ],
  };
}

function score(
  metricId: string,
  userScore: number | null,
  aiSuggestedScore: number,
  userReason = '用户根据验收证据填写',
): QuarterlyScoreItem {
  return {
    id: `score-${metricId}`,
    metricId,
    aiSuggestedScore,
    aiSuggestedMinimum: aiSuggestedScore - 0.5,
    aiSuggestedMaximum: aiSuggestedScore + 0.5,
    aiReason: 'AI 仅供参考',
    aiEvidenceGaps: [],
    aiUncertainty: 'medium',
    userScore,
    userReason,
    rawContribution: null,
    validationStatus: userScore === null ? 'missing' : 'valid',
    version: 1,
  };
}

function achievement(
  id: string,
  status: QuarterlyAchievement['selectionStatus'],
): QuarterlyAchievement {
  return {
    id,
    reviewId: 'review',
    project: null,
    sourceType: 'manual',
    sourceKey: `manual:${id}`,
    title: id,
    situation: '背景',
    action: '行动',
    result: '结果',
    impact: '影响',
    contributionBoundary: '个人贡献边界',
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
    selectionStatus: status,
    exclusionReason: null,
    evidenceStatus: 'complete',
    sortOrder: 1,
    version: 1,
    evidences: [],
    metricLinks: [],
    warnings: [],
    createdAt: '2026-06-30T10:00:00.000Z',
    updatedAt: '2026-06-30T10:00:00.000Z',
  };
}

function evidence(sourceId: string, duplicateInReview: boolean) {
  return {
    id: `evidence-${sourceId}`,
    sourceType: 'manual_link',
    sourceId,
    title: '验收记录',
    externalKey: null,
    url: null,
    eventAt: null,
    availabilityState: 'available',
    sourceContentHash: 'b'.repeat(64),
    sourceSummary: {},
    contributionAngle: '支撑交付结果',
    primaryEvidence: true,
    duplicateInReview,
  };
}

function exportArtifact(): QuarterlyExportArtifact {
  return {
    id: 'artifact',
    reviewId: 'review',
    confirmationId: 'confirmation',
    format: 'xlsx',
    templateVersion: 'quarterly-export-v1',
    inputSnapshotHash: 'c'.repeat(64),
    status: 'succeeded',
    attemptCount: 0,
    version: 3,
    jobId: 'job',
    fileName: '季度自评.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentHash: 'd'.repeat(64),
    sizeBytes: 1024,
    qaStatus: 'passed',
    errorCode: null,
    errorSummary: null,
    createdAt: '2026-06-30T10:00:00.000Z',
    startedAt: '2026-06-30T10:00:01.000Z',
    completedAt: '2026-06-30T10:00:02.000Z',
    updatedAt: '2026-06-30T10:00:02.000Z',
  };
}

function reviewSummary(): QuarterlyReviewSummary {
  return {
    id: 'review',
    name: '2026 Q2',
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
    nextPeriodStart: '2026-07-01',
    timezone: 'Asia/Shanghai',
    naturalQuarter: true,
    year: 2026,
    quarter: 2,
    status: 'draft',
    metricTemplateVersionId: null,
    currentNarrativeVersionId: null,
    currentConfirmationId: null,
    achievementCount: 0,
    exportCount: 0,
    version: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  };
}
