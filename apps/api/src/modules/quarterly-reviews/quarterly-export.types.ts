import type { QuarterlyNarrativeContent } from './quarterly-review-ai.policy.js';

export const QUARTERLY_EXPORT_TEMPLATE_VERSION = 'quarterly-export-v1';

export type QuarterlyExportFormat = 'xlsx' | 'docx';

export interface QuarterlyExportMetric {
  id: string;
  code: string;
  name: string;
  definition: string;
  weight: number;
  minimum: number;
  maximum: number;
  step: number;
  required: boolean;
  enabled: boolean;
  order: number;
  evidenceRequirement: Record<string, unknown>;
}

// 这是生成器唯一允许读取的确认事实边界；不得混入活动评审记录或实时 AI 结果。
export interface QuarterlyExportFacts {
  confirmation: {
    id: string;
    snapshotHash: string;
    status: string;
    confirmedAt: string;
    confirmedBy: string;
    achievementsHash: string;
    scoresHash: string;
  };
  review: {
    id: string;
    name: string;
    periodStart: string;
    periodEnd: string;
    timezone: string;
    version: number;
  };
  achievements: Array<{
    id: string;
    projectId: string | null;
    projectName: string | null;
    title: string;
    situation: string;
    action: string;
    result: string;
    impact: string;
    contributionBoundary: string;
    periodStart: string;
    periodEnd: string;
    evidences: Array<{
      id: string;
      sourceType: string;
      sourceId: string;
      title: string;
      externalKey: string | null;
      eventAt: string | null;
      url: string | null;
      availabilityState: string;
      sourceContentHash: string;
      sourceSummary: Record<string, unknown>;
      contributionAngle: string;
      primaryEvidence: boolean;
    }>;
    metricLinks: Array<{
      id: string;
      metricId: string;
      contribution: string;
      version: number;
    }>;
  }>;
  template: {
    id: string;
    versionNo: number;
    formulaType: 'weighted_average_100' | 'weighted_sum' | 'simple_sum';
    roundingRule:
      'none' | 'half_up_integer' | 'half_up_1_decimal' | 'floor_integer' | 'ceil_integer';
    contentHash: string;
    metrics: QuarterlyExportMetric[];
  };
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
  };
  calculation: {
    formulaType: string;
    roundingRule: string;
    rawTotal: number;
    finalTotal: number;
    scoreCount: number;
    metricCount: number;
  };
  completeness: Record<string, unknown>;
  acknowledgements: unknown[];
}

export interface QuarterlyGeneratedArtifact {
  buffer: Buffer;
  extension: QuarterlyExportFormat;
  mimeType: string;
  rendererFacts: Record<string, unknown>;
  qaReport: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  };
}
