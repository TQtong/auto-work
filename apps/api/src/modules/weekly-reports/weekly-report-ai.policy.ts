import { randomBytes } from 'node:crypto';
import { DomainError } from '@auto-work/contracts';
import {
  requestHash,
  weeklyTaskCompletionPercent,
  type WeeklyEvidenceFact,
  type WeeklyManualInput,
  type WeeklyReportField,
  type WeeklyTaskFact,
} from '@auto-work/domain';
import { z } from 'zod';

export const weeklyAiPromptTemplateVersion = 'weekly-report-ai-prompt-v4';
export const weeklyAiSanitizationPolicyVersion = 'weekly-report-ai-sanitization-v2';
export const weeklyAiMaximumRawOutputBytes = 2 * 1024 * 1024;

export const weeklyAiFields = [
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
] as const satisfies readonly WeeklyReportField[];

export interface WeeklyAiPolicyConsent {
  allowPeopleNames: boolean;
  allowInternalUrls: boolean;
  allowDescriptionSummaries: boolean;
}

export interface WeeklyAiSanitizationInput {
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  timezone: string;
  selectedFields: WeeklyReportField[];
  baseFields: Record<WeeklyReportField, string>;
  tasks: WeeklyTaskFact[];
  evidence: WeeklyEvidenceFact[];
  manualInputs: WeeklyManualInput[];
  consent: WeeklyAiPolicyConsent;
}

export interface WeeklyAiStoredReference {
  refId: string;
  sourceType: 'base_field' | 'task' | 'evidence' | 'manual';
  sourceId: string;
  field: WeeklyReportField | null;
  contentHash: string;
}

interface WeeklyAiValidationReference extends WeeklyAiStoredReference {
  issueKeys: Set<string>;
  dates: Set<string>;
  numbers: Set<string>;
  projectNames: Set<string>;
  sourceTexts: Set<string>;
  parentTitle: string | null;
  completionPercent: number | null;
}

interface WeeklyAiSanitizedSource {
  refId: string;
  kind: WeeklyAiStoredReference['sourceType'];
  field?: WeeklyReportField;
  issueKey?: string;
  projectName?: string;
  parentTitle?: string;
  title?: string;
  status?: string;
  text?: string;
  sourceType?: WeeklyEvidenceFact['sourceType'];
  eventAt?: string;
  plannedStartDate?: string;
  dueDate?: string;
  actualHours?: number;
  estimatedHours?: number;
  remainingHours?: number;
  completionPercent?: number;
  pipelineStatus?: string;
  url?: string;
}

export interface WeeklyAiSanitizedInput {
  policyVersion: typeof weeklyAiSanitizationPolicyVersion;
  purpose: 'weekly_report';
  period: {
    start: string;
    end: string;
    reportDate: string;
    timezone: string;
  };
  requestedFields: WeeklyReportField[];
  sources: WeeklyAiSanitizedSource[];
}

export interface WeeklyAiSanitizationResult {
  sanitizedInput: WeeklyAiSanitizedInput;
  sanitizedInputHash: string;
  storedReferences: WeeklyAiStoredReference[];
  inputCategories: string[];
  removedCategories: string[];
  estimatedInputTokens: number;
  /** 仅供本次进程内校验，调用方不得将其中的事实集合序列化落库。 */
  validationReferences: Map<string, WeeklyAiValidationReference>;
}

export interface WeeklyAiValidatedParagraph {
  projectName: string | null;
  parentTitle: string | null;
  completionPercent: number | null;
  text: string;
  citations: string[];
}

export interface WeeklyAiValidatedField {
  field: WeeklyReportField;
  paragraphs: WeeklyAiValidatedParagraph[];
}

export interface WeeklyAiValidatedOutput {
  fields: WeeklyAiValidatedField[];
  fieldTexts: Record<WeeklyReportField, string>;
}

const outputParagraphSchema = z
  .object({
    projectName: z.string().trim().min(1).max(200).nullable(),
    parentTitle: z.string().trim().min(1).max(500).nullable().optional().default(null),
    completionPercent: z.number().int().min(0).max(100).nullable().optional().default(null),
    text: z.string().trim().min(1).max(20_000),
    citations: z.array(z.string().trim().min(8).max(100)).min(1).max(20),
  })
  .strict();

const outputFieldSchema = z
  .object({
    field: z.enum(weeklyAiFields),
    paragraphs: z.array(outputParagraphSchema).max(100),
  })
  .strict();

const outputSchema = z.object({ fields: z.array(outputFieldSchema).min(1).max(5) }).strict();

/**
 * 净化采用“重新构造白名单对象”，而不是先收集所有源数据再删除危险字段。
 * 因此源码、diff、环境变量、附件正文等字段从类型和运行时路径上都无法进入请求。
 */
export function sanitizeWeeklyAiInput(
  input: WeeklyAiSanitizationInput,
): WeeklyAiSanitizationResult {
  const selectedFields = normalizeFields(input.selectedFields);
  const removedCategories = new Set<string>();
  if (!input.consent.allowPeopleNames) removedCategories.add('people_names');
  if (!input.consent.allowDescriptionSummaries) {
    removedCategories.add('jira_description_summaries');
  }
  if (!input.consent.allowInternalUrls && input.evidence.some((item) => Boolean(item.url))) {
    removedCategories.add('internal_urls');
  }

  const sources: WeeklyAiSanitizedSource[] = [];
  const storedReferences: WeeklyAiStoredReference[] = [];
  const validationReferences = new Map<string, WeeklyAiValidationReference>();
  const inputCategories = new Set<string>();

  for (const field of selectedFields) {
    const baseText = input.baseFields[field].trim();
    // AI 填写允许从空白周报开始；空栏位不是事实来源，直接跳过即可。
    if (!baseText) continue;
    addSource(
      {
        refId: referenceId(),
        kind: 'base_field',
        field,
        text: requireSafeText(baseText, `baseFields.${field}`),
      },
      field,
      field,
    );
    inputCategories.add('weekly_report_base_fields');
  }

  for (const task of input.tasks) {
    if (!task.isCurrentUser || task.visibilityState !== 'visible') continue;
    const actualHours = secondsToHours(task.timeSpentSeconds);
    const estimatedHours = secondsToHours(task.originalEstimateSeconds);
    const remainingHours = secondsToHours(task.remainingEstimateSeconds);
    const source: WeeklyAiSanitizedSource = {
      refId: referenceId(),
      kind: 'task',
      ...(task.issueKey ? { issueKey: requireSafeText(task.issueKey, 'task.issueKey') } : {}),
      projectName: requireSafeText(task.projectName, 'task.projectName'),
      ...(task.parentTitle
        ? { parentTitle: requireSafeText(task.parentTitle, 'task.parentTitle') }
        : {}),
      title: requireSafeText(task.title, 'task.title'),
      status: task.normalizedStatus,
      completionPercent: weeklyTaskCompletionPercent(task),
      ...(task.plannedStartDate ? { plannedStartDate: task.plannedStartDate } : {}),
      ...(task.dueDate ? { dueDate: task.dueDate } : {}),
      ...(actualHours !== undefined ? { actualHours } : {}),
      ...(estimatedHours !== undefined ? { estimatedHours } : {}),
      ...(remainingHours !== undefined ? { remainingHours } : {}),
    };
    addSource(source, task.id, null);
    inputCategories.add('jira_metadata');
  }

  for (const item of input.evidence) {
    if (item.availabilityState === 'unavailable' || item.relationStatus === 'rejected') continue;
    const source: WeeklyAiSanitizedSource = {
      refId: referenceId(),
      kind: 'evidence',
      sourceType: item.sourceType,
      title: requireSafeText(item.title, 'evidence.title'),
      ...(item.eventAt ? { eventAt: item.eventAt } : {}),
      ...(item.pipelineStatus
        ? { pipelineStatus: requireSafeText(item.pipelineStatus, 'evidence.pipelineStatus') }
        : {}),
    };
    if (item.url && input.consent.allowInternalUrls) {
      const safeUrl = sanitizeConditionalUrl(item.url);
      source.url = safeUrl.value;
      if (safeUrl.removedQuery) removedCategories.add('url_queries_and_fragments');
    }
    addSource(source, item.id, null);
    inputCategories.add('git_metadata');
  }

  for (const item of input.manualInputs) {
    const source: WeeklyAiSanitizedSource = {
      refId: referenceId(),
      kind: 'manual',
      field: item.field,
      text: requireSafeText(item.text, 'manualInput.text'),
      ...(item.projectName
        ? { projectName: requireSafeText(item.projectName, 'manualInput.projectName') }
        : {}),
    };
    addSource(source, item.id, item.field);
    inputCategories.add('manual_inputs');
  }

  if (sources.length === 0) {
    throw new DomainError(
      'AI_SANITIZED_INPUT_EMPTY',
      '没有可用于 AI 生成的白名单事实，请先同步任务或填写周报内容',
      {
        httpStatus: 422,
        details: { policyVersion: weeklyAiSanitizationPolicyVersion },
      },
    );
  }

  const sanitizedInput: WeeklyAiSanitizedInput = {
    policyVersion: weeklyAiSanitizationPolicyVersion,
    purpose: 'weekly_report',
    period: {
      start: input.periodStart,
      end: input.periodEnd,
      reportDate: input.reportDate,
      timezone: input.timezone,
    },
    requestedFields: selectedFields,
    sources,
  };
  const serialized = JSON.stringify(sanitizedInput);
  return {
    sanitizedInput,
    sanitizedInputHash: requestHash(sanitizedInput),
    storedReferences,
    inputCategories: [...inputCategories].sort(),
    removedCategories: [...removedCategories].sort(),
    estimatedInputTokens: estimateTokens(serialized),
    validationReferences,
  };

  function addSource(
    source: WeeklyAiSanitizedSource,
    sourceId: string,
    field: WeeklyReportField | null,
  ): void {
    const contentHash = requestHash(source);
    const stored: WeeklyAiStoredReference = {
      refId: source.refId,
      sourceType: source.kind,
      sourceId,
      field,
      contentHash,
    };
    sources.push(source);
    storedReferences.push(stored);
    validationReferences.set(source.refId, {
      ...stored,
      issueKeys: extractIssueKeys(source),
      dates: extractDates(source),
      numbers: extractNumbers(source),
      projectNames: source.projectName ? new Set([normalizeFact(source.projectName)]) : new Set(),
      sourceTexts: extractProjectSupportingTexts(source),
      parentTitle: source.parentTitle ?? null,
      completionPercent: source.completionPercent ?? null,
    });
  }
}

export function buildWeeklyAiGenerationRequest(policy: WeeklyAiSanitizationResult): {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: Record<string, unknown>;
  estimatedInputTokens: number;
} {
  const systemPrompt = [
    '你是本地周报的文字改写器，只能依据用户消息中的白名单事实改写，不能补充、推断或编造。',
    '必须以 base_field 中的当前周报正文为基础进行优化，保留其中已有的有效信息；任务和证据只用于补充或改善表达。',
    '每个段落必须给出至少一个 citations 引用；日期、数字、工单号和项目名必须被所引引用直接支持。',
    'projectName 只能填写当前段落 citations 明确支持的项目名；没有项目依据时必须返回 null。',
    'weeklyWork 必须每个 Jira 子任务单独返回一个段落，并填写该任务来源中的 parentTitle 与 completionPercent；不得把不同父任务合并成一个段落。',
    'completionPercent 是完成度百分比，必须原样使用任务来源给出的 0 到 100 整数；正文应说明任务进展，但系统会统一追加“完成度 N%”。',
    'parentTitle 必须原样使用任务来源中的父任务名称；没有父任务时返回 null，系统会按父任务或项目名称分组展示。',
    '周报正文必须以 Jira 任务标题 title 为主体，不要输出工单号、refId 或 [citation:...] 等内部引用标记。',
    '某个栏位没有可靠的新内容或无法安全优化时，返回该栏位但将 paragraphs 设为空数组，系统会保留原文；不要填写“暂无”“无明确问题”等占位句。',
    '不得输出动作、工具调用、代码、HTML、Markdown 代码块、源码、diff、凭证或附件内容。',
    '不要使用带数字的列表编号；无法可靠改写时，应忠实复述已引用的原文。',
    '只返回符合 JSON Schema 的 JSON，不得返回解释或代码围栏。',
  ].join('\n');
  const userPrompt = JSON.stringify({
    task: 'rewrite_weekly_report_fields',
    promptTemplateVersion: weeklyAiPromptTemplateVersion,
    input: policy.sanitizedInput,
  });
  return {
    systemPrompt,
    userPrompt,
    outputSchema: weeklyAiOutputJsonSchema(policy.sanitizedInput.requestedFields),
    estimatedInputTokens: estimateTokens(`${systemPrompt}\n${userPrompt}`),
  };
}

export function validateWeeklyAiOutput(
  rawOutput: string,
  policy: WeeklyAiSanitizationResult,
  baseFields: Record<WeeklyReportField, string>,
): WeeklyAiValidatedOutput {
  if (Buffer.byteLength(rawOutput, 'utf8') > weeklyAiMaximumRawOutputBytes) {
    throw outputError('AI_OUTPUT_TOO_LARGE', 'AI 输出超过 2 MiB 安全上限');
  }
  const sensitiveCategories = detectSensitiveCategories(rawOutput);
  if (sensitiveCategories.length > 0) {
    // 供应商即使在安全输入下自行产生疑似秘密，也不得进入原始输出留存或建议版本。
    throw new DomainError('AI_OUTPUT_SECURITY_BLOCKED', 'AI 输出被本地安全策略阻断', {
      httpStatus: 422,
      details: {
        categories: sensitiveCategories,
        policyVersion: weeklyAiSanitizationPolicyVersion,
      },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw outputError('AI_OUTPUT_JSON_INVALID', 'AI 输出不是有效 JSON');
  }
  const result = outputSchema.safeParse(
    normalizeWeeklyAiOutputShape(parsed, policy.sanitizedInput.requestedFields),
  );
  if (!result.success) {
    throw outputError('AI_OUTPUT_SCHEMA_INVALID', 'AI 输出不符合周报建议结构');
  }
  const requested = policy.sanitizedInput.requestedFields;
  const returned = result.data.fields.map((item) => item.field);
  if (
    returned.length !== requested.length ||
    new Set(returned).size !== returned.length ||
    requested.some((field) => !returned.includes(field))
  ) {
    throw outputError('AI_OUTPUT_FIELD_SET_INVALID', 'AI 输出字段与请求范围不一致');
  }

  for (const field of result.data.fields) {
    for (const paragraph of field.paragraphs) {
      paragraph.text = cleanWeeklyAiCitations(paragraph.text);
      if (!paragraph.text) {
        throw outputError('AI_OUTPUT_TEXT_EMPTY', 'AI 输出清理内部标记后正文为空');
      }
      if (/```|<\/?[a-z][^>]*>/iu.test(paragraph.text)) {
        throw outputError('AI_OUTPUT_ACTIVE_CONTENT_REJECTED', 'AI 输出包含代码围栏或 HTML');
      }
      if (new Set(paragraph.citations).size !== paragraph.citations.length) {
        throw outputError('AI_OUTPUT_CITATION_DUPLICATED', 'AI 输出段落包含重复引用');
      }
      const cited = paragraph.citations.map((refId) => {
        const reference = policy.validationReferences.get(refId);
        if (!reference) {
          throw outputError('AI_OUTPUT_CITATION_UNKNOWN', 'AI 输出引用了本次输入之外的依据');
        }
        return reference;
      });
      if (paragraph.projectName && !isProjectSupported(paragraph.projectName, cited)) {
        // projectName 只是展示分组元数据。模型偶尔会把其他段落的项目标签复制过来；
        // 本地直接丢弃无依据标签，正文仍必须继续通过逐项事实与引用校验。
        paragraph.projectName = null;
      }
      const citedParentTitles = [
        ...new Set(
          cited
            .map((reference) => reference.parentTitle)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      if (
        paragraph.parentTitle &&
        !citedParentTitles.some(
          (parentTitle) => normalizeFact(parentTitle) === normalizeFact(paragraph.parentTitle!),
        )
      ) {
        paragraph.parentTitle = null;
      }
      if (!paragraph.parentTitle && citedParentTitles.length === 1) {
        paragraph.parentTitle = citedParentTitles[0] ?? null;
      }
      const citedCompletionPercents = [
        ...new Set(
          cited
            .map((reference) => reference.completionPercent)
            .filter((value): value is number => value !== null),
        ),
      ];
      if (
        paragraph.completionPercent !== null &&
        !citedCompletionPercents.includes(paragraph.completionPercent)
      ) {
        throw outputError('AI_OUTPUT_COMPLETION_UNSUPPORTED', 'AI 输出中的完成度没有对应任务依据');
      }
      if (paragraph.completionPercent === null && citedCompletionPercents.length === 1) {
        paragraph.completionPercent = citedCompletionPercents[0] ?? null;
      }
      assertFactsSupported('issue', extractIssueKeys(paragraph.text), cited);
      assertFactsSupported('date', extractDates(paragraph.text), cited);
      assertFactsSupported('number', extractNumbers(paragraph.text), cited);
      paragraph.text = cleanWeeklyAiTaskKeys(paragraph.text);
      if (!paragraph.text) {
        throw outputError('AI_OUTPUT_TEXT_EMPTY', 'AI 输出清理内部标记后正文为空');
      }
      if (
        field.field === 'weeklyWork' &&
        paragraph.completionPercent !== null &&
        !/完成度\s*\d{1,3}\s*%/u.test(paragraph.text)
      ) {
        paragraph.text = `${paragraph.text.replace(/[。；;]\s*$/u, '')}（完成度 ${paragraph.completionPercent}%）`;
      }
    }
  }

  const fieldTexts = { ...baseFields };
  for (const field of result.data.fields) {
    const meaningful = field.paragraphs.filter(
      (paragraph) => !isEmptyWeeklyPlaceholder(field.field, paragraph.text),
    );
    field.paragraphs = meaningful;
    if (meaningful.length > 0) {
      fieldTexts[field.field] =
        field.field === 'weeklyWork'
          ? renderGroupedWeeklyAiWork(meaningful)
          : meaningful
              .map(
                (paragraph, index) =>
                  `${index + 1}、${paragraph.text.replace(/^\s*\d+[、.．]\s*/u, '')}`,
              )
              .join('\n');
    }
  }
  return { fields: result.data.fields, fieldTexts };
}

function renderGroupedWeeklyAiWork(paragraphs: WeeklyAiValidatedParagraph[]): string {
  const groups = new Map<string, WeeklyAiValidatedParagraph[]>();
  for (const paragraph of paragraphs) {
    const title = paragraph.parentTitle ?? paragraph.projectName ?? '未归属父任务';
    groups.set(title, [...(groups.get(title) ?? []), paragraph]);
  }
  return [...groups.entries()]
    .map(
      ([title, items]) =>
        `【${title}】\n${items
          .map(
            (paragraph, index) =>
              `${index + 1}、${paragraph.text.replace(/^\s*\d+[、.．]\s*/u, '')}`,
          )
          .join('\n')}`,
    )
    .join('\n\n');
}

function normalizeWeeklyAiOutputShape(
  parsed: unknown,
  requestedFields: WeeklyReportField[],
): unknown {
  if (!isPlainObject(parsed)) return parsed;

  if (Array.isArray(parsed.fields)) {
    return {
      ...parsed,
      fields: parsed.fields.map((field) => normalizeWeeklyAiFieldShape(field)),
    };
  }

  const keys = Object.keys(parsed);
  if (
    keys.length !== requestedFields.length ||
    keys.some((key) => !requestedFields.includes(key as WeeklyReportField))
  ) {
    return parsed;
  }

  return {
    fields: requestedFields.map((field) => {
      const value = parsed[field];
      if (!isPlainObject(value)) return value;
      return normalizeWeeklyAiFieldShape({ field, ...value });
    }),
  };
}

function normalizeWeeklyAiFieldShape(value: unknown): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.paragraphs)) return value;
  const paragraphs = value.paragraphs as unknown[];
  return {
    ...value,
    paragraphs: paragraphs.map((paragraph) => {
      if (!isPlainObject(paragraph)) return paragraph;
      return {
        ...paragraph,
        projectName: Object.hasOwn(paragraph, 'projectName') ? paragraph.projectName : null,
        parentTitle: Object.hasOwn(paragraph, 'parentTitle') ? paragraph.parentTitle : null,
        completionPercent: Object.hasOwn(paragraph, 'completionPercent')
          ? paragraph.completionPercent
          : null,
      };
    }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanWeeklyAiCitations(value: string): string {
  return value
    .replace(/\s*[[【]citation\s*:\s*[^\]】]+[\]】]/giu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function cleanWeeklyAiTaskKeys(value: string): string {
  return value
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b\s*[,，:：、]?\s*/gu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function isEmptyWeeklyPlaceholder(field: WeeklyReportField, value: string): boolean {
  const normalized = value.replace(/[。.!！\s]/gu, '');
  if (normalized === '暂无' || normalized === '无') return true;
  if (field === 'nextWeekPlans') {
    return ['无明确计划', '暂无计划', '无下周计划'].includes(normalized);
  }
  if (field === 'problems') {
    return ['无明确问题', '暂无问题', '无问题', '无风险', '暂无风险', '无问题与风险'].includes(
      normalized,
    );
  }
  if (field === 'other') {
    return ['无其他事项', '暂无其他事项', '无其他补充', '暂无其他补充'].includes(normalized);
  }
  return false;
}

function weeklyAiOutputJsonSchema(selectedFields: WeeklyReportField[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        minItems: selectedFields.length,
        maxItems: selectedFields.length,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: selectedFields },
            paragraphs: {
              type: 'array',
              minItems: 0,
              maxItems: 100,
              items: {
                type: 'object',
                properties: {
                  projectName: { type: ['string', 'null'], maxLength: 200 },
                  parentTitle: { type: ['string', 'null'], maxLength: 500 },
                  completionPercent: {
                    type: ['integer', 'null'],
                    minimum: 0,
                    maximum: 100,
                  },
                  text: { type: 'string', minLength: 1, maxLength: 20_000 },
                  citations: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: { type: 'string', minLength: 8, maxLength: 100 },
                  },
                },
                required: ['projectName', 'parentTitle', 'completionPercent', 'text', 'citations'],
                additionalProperties: false,
              },
            },
          },
          required: ['field', 'paragraphs'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  };
}

function normalizeFields(fields: WeeklyReportField[]): WeeklyReportField[] {
  if (fields.length === 0 || fields.length > weeklyAiFields.length) {
    throw new DomainError('AI_WEEKLY_FIELDS_INVALID', 'AI 改写范围必须包含一至五个周报正文栏位', {
      httpStatus: 422,
    });
  }
  const unique = [...new Set(fields)];
  if (unique.length !== fields.length || unique.some((field) => !weeklyAiFields.includes(field))) {
    throw new DomainError('AI_WEEKLY_FIELDS_INVALID', 'AI 改写范围包含重复或未知栏位', {
      httpStatus: 422,
    });
  }
  return weeklyAiFields.filter((field) => unique.includes(field));
}

function requireSafeText(value: string, field: string): string {
  const text = value.trim();
  if (!text) {
    throw new DomainError('AI_SANITIZED_FIELD_EMPTY', 'AI 白名单输入包含空文本', {
      httpStatus: 422,
      details: { field },
    });
  }
  const categories = detectSensitiveCategories(text);
  if (categories.length > 0) {
    // 只返回类别和字段路径，绝不把命中的秘密原文写入异常、日志或数据库。
    throw new DomainError('AI_INPUT_SECURITY_BLOCKED', 'AI 输入被本地安全策略阻断', {
      httpStatus: 422,
      details: { field, categories, policyVersion: weeklyAiSanitizationPolicyVersion },
    });
  }
  return text;
}

export function detectSensitiveCategories(value: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ['private_keys', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu],
    ['authorization_headers', /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/iu],
    [
      'token_patterns',
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
    ],
    [
      'credential_assignments',
      /\b(?:api[_-]?key|token|secret|password|passwd|webhook)\s*[:=]\s*[^\s,;]{6,}/iu,
    ],
    ['connection_strings', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/iu],
    ['source_diffs', /(?:^|\n)(?:diff --git |@@ -\d|\+\+\+ [ab]\/|--- [ab]\/)/u],
    [
      'source_code',
      /```(?:[A-Za-z0-9_+-]+)?\s*[\s\S]*```|(?:^|\n)\s*(?:import|export|class|function|interface|const|let|var)\s+[A-Za-z_$]/u,
    ],
    ['customer_sensitive_data', /(?:身份证|银行卡|客户.{0,8}(?:手机号|邮箱|住址|地址))/u],
  ];
  return checks.filter(([, expression]) => expression.test(value)).map(([category]) => category);
}

function sanitizeConditionalUrl(value: string): { value: string; removedQuery: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError('AI_INPUT_URL_INVALID', '获准发送的依据 URL 格式无效', {
      httpStatus: 422,
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new DomainError('AI_INPUT_URL_UNSAFE', '获准发送的依据 URL 必须使用 HTTPS', {
      httpStatus: 422,
    });
  }
  const removedQuery = Boolean(parsed.search || parsed.hash || parsed.username || parsed.password);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const safe = parsed.toString();
  const categories = detectSensitiveCategories(safe);
  if (categories.length > 0) {
    throw new DomainError('AI_INPUT_SECURITY_BLOCKED', 'AI 输入 URL 被本地安全策略阻断', {
      httpStatus: 422,
      details: {
        field: 'evidence.url',
        categories,
        policyVersion: weeklyAiSanitizationPolicyVersion,
      },
    });
  }
  return { value: safe, removedQuery };
}

function secondsToHours(seconds: number | null | undefined): number | undefined {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round((seconds / 3_600) * 100) / 100;
}

function referenceId(): string {
  return `ref_${randomBytes(18).toString('base64url')}`;
}

function extractIssueKeys(value: unknown): Set<string> {
  return extractStrings(value, /\b[A-Z][A-Z0-9]+-\d+\b/gu, (fact) => fact.toUpperCase());
}

function extractDates(value: unknown): Set<string> {
  return extractStrings(value, /\b\d{4}-\d{2}-\d{2}\b/gu, normalizeFact);
}

function extractNumbers(value: unknown): Set<string> {
  const json = flattenStrings(value)
    .join('\n')
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/gu, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ');
  const matches =
    json.match(/(?<![\p{L}\p{N}_])\d+(?:\.\d+)?(?:\s*(?:小时|分钟|秒|天|个|项|次|%))?/gu) ?? [];
  return new Set(
    matches.map((fact) => normalizeFact(fact.replace(/(?:小时|分钟|秒|天|个|项|次|%)$/u, ''))),
  );
}

function extractProjectSupportingTexts(source: WeeklyAiSanitizedSource): Set<string> {
  return new Set(
    [source.projectName, source.parentTitle, source.title, source.text]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(normalizeFact),
  );
}

function isProjectSupported(
  projectName: string,
  citations: WeeklyAiValidationReference[],
): boolean {
  const normalizedProjectName = normalizeFact(projectName);
  return citations.some(
    (citation) =>
      citation.projectNames.has(normalizedProjectName) ||
      [...citation.sourceTexts].some((text) => text.includes(normalizedProjectName)),
  );
}

function extractStrings(
  value: unknown,
  pattern: RegExp,
  normalize: (value: string) => string,
): Set<string> {
  return new Set(
    flattenStrings(value).flatMap((text) => (text.match(pattern) ?? []).map(normalize)),
  );
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenStrings);
  return [];
}

function assertFactsSupported(
  kind: 'issue' | 'date' | 'number',
  facts: Set<string>,
  citations: WeeklyAiValidationReference[],
): void {
  const key = kind === 'issue' ? 'issueKeys' : kind === 'date' ? 'dates' : 'numbers';
  for (const fact of facts) {
    if (!citations.some((citation) => citation[key].has(fact))) {
      const code =
        kind === 'issue'
          ? 'AI_OUTPUT_ISSUE_UNSUPPORTED'
          : kind === 'date'
            ? 'AI_OUTPUT_DATE_UNSUPPORTED'
            : 'AI_OUTPUT_NUMBER_UNSUPPORTED';
      throw outputError(
        code,
        `AI 输出中的${kind === 'issue' ? '工单号' : kind === 'date' ? '日期' : '数字'}没有引用依据`,
      );
    }
  }
}

function normalizeFact(value: string): string {
  return value.trim().replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function outputError(code: string, message: string): DomainError {
  return new DomainError(code, message, { httpStatus: 422 });
}
