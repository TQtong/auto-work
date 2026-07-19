import { randomBytes } from 'node:crypto';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import { z } from 'zod';
import { detectSensitiveCategories } from '../weekly-reports/weekly-report-ai.policy.js';

export const quarterlyAiPromptTemplateVersion = 'quarterly-review-ai-prompt-v1';
export const quarterlyAiSanitizationPolicyVersion = 'quarterly-review-ai-sanitization-v1';
export const quarterlyAiMaximumRawOutputBytes = 2 * 1024 * 1024;

export interface QuarterlyAiMetric {
  id: string;
  code: string;
  name: string;
  definition: string;
  minimum: number;
  maximum: number;
  step: number;
  required: boolean;
}

export interface QuarterlyAiEvidence {
  id: string;
  sourceType: string;
  title: string;
  externalKey: string | null;
  eventAt: Date | null;
  availabilityState: string;
  contributionAngle: string;
  sourceSummaryJson: string;
}

export interface QuarterlyAiAchievement {
  id: string;
  projectName: string | null;
  title: string;
  situation: string;
  action: string;
  result: string;
  impact: string;
  contributionBoundary: string;
  periodStart: string;
  periodEnd: string;
  metricIds: string[];
  evidences: QuarterlyAiEvidence[];
}

interface ValidationReference {
  refId: string;
  achievementId: string;
  metricIds: Set<string>;
  evidenceIds: Set<string>;
  facts: Set<string>;
}

export interface QuarterlyAiPolicyResult {
  purpose: 'quarterly_review' | 'score_suggestion';
  sanitizedInput: Record<string, unknown>;
  sanitizedInputHash: string;
  storedReferences: Array<{
    refId: string;
    sourceType: 'achievement';
    sourceId: string;
    contentHash: string;
  }>;
  inputCategories: string[];
  removedCategories: string[];
  estimatedInputTokens: number;
  metrics: QuarterlyAiMetric[];
  references: Map<string, ValidationReference>;
}

export interface QuarterlyScoreSuggestion {
  metricId: string;
  suggestedScore: number;
  suggestedMinimum: number;
  suggestedMaximum: number;
  reason: string;
  evidenceGaps: string[];
  uncertainty: 'low' | 'medium' | 'high';
  citations: string[];
}

export interface QuarterlyNarrativeContent {
  overallOverview: string;
  coreAchievements: Array<{
    heading: string;
    body: string;
    achievementIds: string[];
    metricIds: string[];
    evidenceIds: string[];
  }>;
  collaborationAndGrowth: string;
  problemsAndImprovements: string;
  nextPeriodPlan: string;
}

export interface QuarterlyNarrativeOutput {
  content: QuarterlyNarrativeContent;
  sections: Array<{
    section:
      | 'overallOverview'
      | 'coreAchievements'
      | 'collaborationAndGrowth'
      | 'problemsAndImprovements'
      | 'nextPeriodPlan';
    text: string;
    citations: string[];
  }>;
}

const scoreOutputSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            metricId: z.string().min(1).max(100),
            suggestedScore: z.number().finite(),
            suggestedMinimum: z.number().finite(),
            suggestedMaximum: z.number().finite(),
            reason: z.string().trim().min(1).max(4_000),
            evidenceGaps: z.array(z.string().trim().min(1).max(500)).max(30),
            uncertainty: z.enum(['low', 'medium', 'high']),
            citations: z.array(z.string().min(8).max(100)).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const narrativeOutputSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            section: z.enum([
              'overallOverview',
              'coreAchievements',
              'collaborationAndGrowth',
              'problemsAndImprovements',
              'nextPeriodPlan',
            ]),
            text: z.string().trim().min(1).max(20_000),
            citations: z.array(z.string().min(8).max(100)).min(1).max(100),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();

/**
 * 季度 AI 输入采用重新构造的白名单对象。源码、diff、附件正文、URL、人员标识和原始来源 JSON
 * 都没有进入对象的字段通道；来源摘要仅提取允许的量化值，绝不直接转发。
 */
export function sanitizeQuarterlyAiInput(input: {
  purpose: QuarterlyAiPolicyResult['purpose'];
  review: { name: string; periodStart: string; periodEnd: string; timezone: string };
  metrics: QuarterlyAiMetric[];
  achievements: QuarterlyAiAchievement[];
}): QuarterlyAiPolicyResult {
  if (input.achievements.length === 0) {
    throw policyError(
      'QUARTERLY_AI_SELECTED_ACHIEVEMENT_REQUIRED',
      '至少选择一项成果后才能生成建议',
    );
  }
  if (input.purpose === 'score_suggestion' && input.metrics.length === 0) {
    throw policyError('QUARTERLY_AI_METRIC_TEMPLATE_REQUIRED', '评分建议必须基于已绑定指标模板');
  }
  const references = new Map<string, ValidationReference>();
  const storedReferences: QuarterlyAiPolicyResult['storedReferences'] = [];
  const achievementSources = input.achievements.map((achievement) => {
    const refId = `qref_${randomBytes(18).toString('base64url')}`;
    const evidence = achievement.evidences
      .filter((item) => item.availabilityState !== 'unavailable')
      .map((item) => ({
        id: item.id,
        sourceType: safeText(item.sourceType, 'evidence.sourceType'),
        title: safeText(item.title, 'evidence.title'),
        externalKey: item.externalKey ? safeText(item.externalKey, 'evidence.externalKey') : null,
        eventAt: item.eventAt?.toISOString() ?? null,
        availabilityState: safeText(item.availabilityState, 'evidence.availabilityState'),
        contributionAngle: safeText(item.contributionAngle, 'evidence.contributionAngle'),
        quantitativeFacts: extractAllowedQuantitativeFacts(item.sourceSummaryJson),
      }));
    const source = {
      refId,
      achievementId: achievement.id,
      projectName: achievement.projectName
        ? safeText(achievement.projectName, 'achievement.projectName')
        : null,
      title: safeText(achievement.title, 'achievement.title'),
      situation: safeText(achievement.situation, 'achievement.situation'),
      action: safeText(achievement.action, 'achievement.action'),
      result: safeText(achievement.result, 'achievement.result'),
      impact: safeText(achievement.impact, 'achievement.impact'),
      contributionBoundary: safeText(
        achievement.contributionBoundary,
        'achievement.contributionBoundary',
      ),
      periodStart: achievement.periodStart,
      periodEnd: achievement.periodEnd,
      metricIds: [...new Set(achievement.metricIds)].sort(),
      evidence,
    };
    const contentHash = requestHash(source);
    storedReferences.push({
      refId,
      sourceType: 'achievement',
      sourceId: achievement.id,
      contentHash,
    });
    references.set(refId, {
      refId,
      achievementId: achievement.id,
      metricIds: new Set(source.metricIds),
      evidenceIds: new Set(evidence.map((item) => item.id)),
      facts: extractFacts(source),
    });
    return source;
  });
  const sanitizedInput = {
    policyVersion: quarterlyAiSanitizationPolicyVersion,
    purpose: input.purpose,
    review: input.review,
    metrics: input.metrics.map((metric) => ({ ...metric })),
    selectedAchievements: achievementSources,
  };
  return {
    purpose: input.purpose,
    sanitizedInput,
    sanitizedInputHash: requestHash(sanitizedInput),
    storedReferences,
    inputCategories: ['achievement_structured_fields', 'evidence_metadata', 'metric_definitions'],
    removedCategories: [
      'attachments',
      'credentials',
      'diffs',
      'people_identifiers',
      'raw_source_metadata',
      'source_code',
      'urls',
    ],
    estimatedInputTokens: estimateTokens(JSON.stringify(sanitizedInput)),
    metrics: input.metrics,
    references,
  };
}

export function buildQuarterlyAiRequest(policy: QuarterlyAiPolicyResult) {
  const scoring = policy.purpose === 'score_suggestion';
  const systemPrompt = [
    '你是季度绩效材料整理器，只能依据输入中的白名单事实，不得补充、推断或编造。',
    '每段事实和每项评分理由必须引用 citations；日期、数字、工单号和项目名必须由引用直接支持。',
    '不得依据提交次数、代码行数或工作时长直接推断绩效分，不得输出或修改 userScore。',
    '不得输出动作、工具调用、代码、HTML、Markdown 代码块、凭证或附件内容。',
    '只返回符合 JSON Schema 的 JSON，不得返回解释或代码围栏。',
  ].join('\n');
  const userPrompt = JSON.stringify({
    task: scoring ? 'suggest_scores_without_user_score_mutation' : 'draft_quarterly_narrative',
    promptTemplateVersion: quarterlyAiPromptTemplateVersion,
    input: policy.sanitizedInput,
  });
  return {
    systemPrompt,
    userPrompt,
    outputSchema: scoring ? scoreJsonSchema(policy.metrics) : narrativeJsonSchema(),
    estimatedInputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
  };
}

export function validateQuarterlyScoreOutput(
  rawOutput: string,
  policy: QuarterlyAiPolicyResult,
): QuarterlyScoreSuggestion[] {
  const parsed = parseOutput(rawOutput);
  const result = scoreOutputSchema.safeParse(parsed);
  if (!result.success)
    throw policyError('QUARTERLY_AI_SCORE_SCHEMA_INVALID', 'AI 评分建议结构无效');
  const metricById = new Map(policy.metrics.map((metric) => [metric.id, metric]));
  if (
    result.data.suggestions.length !== policy.metrics.length ||
    new Set(result.data.suggestions.map((item) => item.metricId)).size !== policy.metrics.length ||
    policy.metrics.some(
      (metric) => !result.data.suggestions.some((item) => item.metricId === metric.id),
    )
  ) {
    throw policyError('QUARTERLY_AI_SCORE_METRIC_SET_INVALID', 'AI 必须逐项返回当前模板的全部指标');
  }
  for (const item of result.data.suggestions) {
    const metric = metricById.get(item.metricId)!;
    if (
      item.suggestedMinimum < metric.minimum ||
      item.suggestedMaximum > metric.maximum ||
      item.suggestedMinimum > item.suggestedScore ||
      item.suggestedScore > item.suggestedMaximum ||
      !onStep(item.suggestedScore, metric.minimum, metric.step) ||
      !onStep(item.suggestedMinimum, metric.minimum, metric.step) ||
      !onStep(item.suggestedMaximum, metric.minimum, metric.step)
    ) {
      throw policyError('QUARTERLY_AI_SCORE_RANGE_INVALID', 'AI 评分建议不符合指标范围或步长');
    }
    const cited = validateCitations(item.citations, policy);
    if (!cited.some((reference) => reference.metricIds.has(item.metricId))) {
      throw policyError('QUARTERLY_AI_SCORE_EVIDENCE_UNMAPPED', '评分建议未引用映射到该指标的成果');
    }
    assertFactsSupported(item.reason, cited);
  }
  return result.data.suggestions;
}

export function validateQuarterlyNarrativeOutput(
  rawOutput: string,
  policy: QuarterlyAiPolicyResult,
): QuarterlyNarrativeOutput {
  const parsed = parseOutput(rawOutput);
  const result = narrativeOutputSchema.safeParse(parsed);
  if (!result.success)
    throw policyError('QUARTERLY_AI_NARRATIVE_SCHEMA_INVALID', 'AI 自评结构无效');
  const expected = [
    'overallOverview',
    'coreAchievements',
    'collaborationAndGrowth',
    'problemsAndImprovements',
    'nextPeriodPlan',
  ] as const;
  if (
    new Set(result.data.sections.map((section) => section.section)).size !== expected.length ||
    expected.some((section) => !result.data.sections.some((item) => item.section === section))
  ) {
    throw policyError('QUARTERLY_AI_NARRATIVE_SECTION_SET_INVALID', 'AI 自评必须包含五个完整章节');
  }
  for (const section of result.data.sections) {
    const cited = validateCitations(section.citations, policy);
    assertFactsSupported(section.text, cited);
  }
  const byName = new Map(result.data.sections.map((section) => [section.section, section]));
  const core = byName.get('coreAchievements')!;
  const cited = validateCitations(core.citations, policy);
  return {
    sections: result.data.sections,
    content: {
      overallOverview: byName.get('overallOverview')!.text,
      coreAchievements: cited.map((reference) => ({
        heading: `成果 ${reference.achievementId}`,
        body: core.text,
        achievementIds: [reference.achievementId],
        metricIds: [...reference.metricIds].sort(),
        evidenceIds: [...reference.evidenceIds].sort(),
      })),
      collaborationAndGrowth: byName.get('collaborationAndGrowth')!.text,
      problemsAndImprovements: byName.get('problemsAndImprovements')!.text,
      nextPeriodPlan: byName.get('nextPeriodPlan')!.text,
    },
  };
}

export function buildRuleNarrative(
  reviewName: string,
  achievements: QuarterlyAiAchievement[],
): QuarterlyNarrativeContent {
  return {
    overallOverview: `${reviewName}期间共确认 ${achievements.length} 项核心成果，以下内容按已选择成果及证据整理。`,
    coreAchievements: achievements.map((achievement) => ({
      heading: achievement.title,
      body: `${achievement.situation}；采取行动：${achievement.action}；结果：${achievement.result}；影响：${achievement.impact}；贡献边界：${achievement.contributionBoundary}`,
      achievementIds: [achievement.id],
      metricIds: [...new Set(achievement.metricIds)].sort(),
      evidenceIds: achievement.evidences.map((evidence) => evidence.id).sort(),
    })),
    collaborationAndGrowth: '请结合已确认成果补充本周期的协作方式、能力成长及可核对实例。',
    problemsAndImprovements: '请基于实际问题补充原因、已采取的改进措施及仍需支持的事项。',
    nextPeriodPlan: '请补充下一周期目标、衡量方式、计划时间与依赖条件。',
  };
}

function parseOutput(rawOutput: string): unknown {
  if (Buffer.byteLength(rawOutput, 'utf8') > quarterlyAiMaximumRawOutputBytes) {
    throw policyError('QUARTERLY_AI_OUTPUT_TOO_LARGE', 'AI 输出超过 2 MiB 安全上限');
  }
  const categories = detectSensitiveCategories(rawOutput);
  if (categories.length > 0) {
    throw new DomainError('AI_OUTPUT_SECURITY_BLOCKED', 'AI 输出被本地安全策略阻断', {
      httpStatus: 422,
      details: { categories, policyVersion: quarterlyAiSanitizationPolicyVersion },
    });
  }
  try {
    return JSON.parse(rawOutput) as unknown;
  } catch {
    throw policyError('QUARTERLY_AI_OUTPUT_JSON_INVALID', 'AI 输出不是有效 JSON');
  }
}

function validateCitations(citations: string[], policy: QuarterlyAiPolicyResult) {
  if (new Set(citations).size !== citations.length) {
    throw policyError('QUARTERLY_AI_CITATION_DUPLICATED', 'AI 输出包含重复引用');
  }
  return citations.map((citation) => {
    const reference = policy.references.get(citation);
    if (!reference) throw policyError('QUARTERLY_AI_CITATION_UNKNOWN', 'AI 引用了输入范围外的事实');
    return reference;
  });
}

function assertFactsSupported(text: string, references: ValidationReference[]): void {
  if (/```|<\/?[a-z][^>]*>/iu.test(text)) {
    throw policyError('QUARTERLY_AI_ACTIVE_CONTENT_REJECTED', 'AI 输出包含代码围栏或 HTML');
  }
  const facts = extractFacts(text);
  for (const fact of facts) {
    if (!references.some((reference) => reference.facts.has(fact))) {
      throw policyError('QUARTERLY_AI_FACT_UNSUPPORTED', `AI 输出事实没有引用依据：${fact}`);
    }
  }
}

function extractAllowedQuantitativeFacts(value: string): Array<{ key: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  const allowed = /(?:count|hours?|duration|coverage|rate|percent|total|value|quantity|score)$/iu;
  const facts: Array<{ key: string; value: string }> = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return facts;
  for (const [key, item] of Object.entries(parsed)) {
    if (!allowed.test(key) || (typeof item !== 'number' && typeof item !== 'string')) continue;
    const value = String(item).trim();
    if (/^-?\d+(?:\.\d+)?%?$/u.test(value)) facts.push({ key, value });
  }
  return facts.slice(0, 50);
}

function extractFacts(value: unknown): Set<string> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const issueKeys = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/gu) ?? [];
  const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  const numbers =
    text
      .replace(/\b[A-Z][A-Z0-9]+-\d+\b/gu, ' ')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ')
      .match(/(?<![\p{L}\p{N}_])-?\d+(?:\.\d+)?%?/gu) ?? [];
  return new Set([...issueKeys, ...dates, ...numbers].map((fact) => fact.toLowerCase()));
}

function safeText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw policyError('QUARTERLY_AI_INPUT_EMPTY', `AI 白名单输入为空：${field}`);
  const categories = detectSensitiveCategories(text);
  if (categories.length > 0) {
    throw new DomainError('AI_INPUT_SECURITY_BLOCKED', 'AI 输入被本地安全策略阻断', {
      httpStatus: 422,
      details: { field, categories, policyVersion: quarterlyAiSanitizationPolicyVersion },
    });
  }
  return text;
}

function onStep(value: number, minimum: number, step: number): boolean {
  return Math.abs((value - minimum) / step - Math.round((value - minimum) / step)) < 1e-8;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function policyError(code: string, message: string): DomainError {
  return new DomainError(code, message, { httpStatus: 422 });
}

function scoreJsonSchema(metrics: QuarterlyAiMetric[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        minItems: metrics.length,
        maxItems: metrics.length,
        items: {
          type: 'object',
          properties: {
            metricId: { type: 'string', enum: metrics.map((metric) => metric.id) },
            suggestedScore: { type: 'number' },
            suggestedMinimum: { type: 'number' },
            suggestedMaximum: { type: 'number' },
            reason: { type: 'string' },
            evidenceGaps: { type: 'array', items: { type: 'string' } },
            uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
            citations: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
          required: [
            'metricId',
            'suggestedScore',
            'suggestedMinimum',
            'suggestedMaximum',
            'reason',
            'evidenceGaps',
            'uncertainty',
            'citations',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  };
}

function narrativeJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: [
                'overallOverview',
                'coreAchievements',
                'collaborationAndGrowth',
                'problemsAndImprovements',
                'nextPeriodPlan',
              ],
            },
            text: { type: 'string', minLength: 1, maxLength: 20_000 },
            citations: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
          required: ['section', 'text', 'citations'],
          additionalProperties: false,
        },
      },
    },
    required: ['sections'],
    additionalProperties: false,
  };
}
