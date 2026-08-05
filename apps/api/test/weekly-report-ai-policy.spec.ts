import { describe, expect, it } from 'vitest';
import { DomainError } from '@auto-work/contracts';
import type {
  WeeklyEvidenceFact,
  WeeklyManualInput,
  WeeklyReportField,
  WeeklyTaskFact,
} from '@auto-work/domain';
import {
  buildWeeklyAiGenerationRequest,
  detectSensitiveCategories,
  sanitizeWeeklyAiInput,
  validateWeeklyAiOutput,
  weeklyAiPromptTemplateVersion,
  weeklyAiSanitizationPolicyVersion,
} from '../src/modules/weekly-reports/weekly-report-ai.policy.js';

describe('周报 AI 白名单净化与事实校验', () => {
  it('从冻结事实重新构造白名单，忽略源码/diff/附件等未知字段并生成不可猜测引用', () => {
    const taskWithForbiddenExtras = {
      ...task(),
      sourceCode: 'const secret = process.env.TOKEN',
      diff: 'diff --git a/a b/a',
      attachmentContent: '不得进入模型',
      description: 'Jira 完整描述不得进入模型',
    } as WeeklyTaskFact;
    const result = sanitizeWeeklyAiInput(input({ tasks: [taskWithForbiddenExtras] }));
    const serialized = JSON.stringify(result.sanitizedInput);

    expect(serialized).not.toContain('sourceCode');
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('attachmentContent');
    expect(serialized).not.toContain('Jira 完整描述');
    expect(result.sanitizedInput.policyVersion).toBe(weeklyAiSanitizationPolicyVersion);
    expect(result.storedReferences).toHaveLength(2);
    expect(
      result.storedReferences.every((item) => /^ref_[A-Za-z0-9_-]{24}$/u.test(item.refId)),
    ).toBe(true);
    expect(new Set(result.storedReferences.map((item) => item.refId)).size).toBe(2);
    expect(result.inputCategories).toEqual(['jira_metadata', 'weekly_report_base_fields']);
  });

  it('默认移除条件信息；显式同意 URL 后仍剥离查询、片段和内嵌凭证', () => {
    const evidence: WeeklyEvidenceFact = {
      id: 'evidence-1',
      sourceType: 'merge_request',
      title: '完成合并请求',
      url: 'https://git.example.local/group/repo/-/merge_requests/1?access_token=secret#note',
      eventAt: '2026-07-18T02:00:00.000Z',
      relationStatus: 'confirmed',
      revalidationState: 'valid',
      availabilityState: 'available',
    };
    const blockedByDefault = sanitizeWeeklyAiInput(input({ evidence: [evidence] }));
    expect(JSON.stringify(blockedByDefault.sanitizedInput)).not.toContain('git.example.local');
    expect(blockedByDefault.removedCategories).toContain('internal_urls');

    const allowed = sanitizeWeeklyAiInput(
      input({
        evidence: [evidence],
        consent: {
          allowPeopleNames: false,
          allowInternalUrls: true,
          allowDescriptionSummaries: false,
        },
      }),
    );
    expect(JSON.stringify(allowed.sanitizedInput)).toContain(
      'https://git.example.local/group/repo/-/merge_requests/1',
    );
    expect(JSON.stringify(allowed.sanitizedInput)).not.toContain('access_token');
    expect(allowed.removedCategories).toContain('url_queries_and_fragments');
  });

  it.each([
    ['Authorization: Bearer top-secret-value', 'authorization_headers'],
    ['-----BEGIN PRIVATE KEY-----\nsecret', 'private_keys'],
    ['API_KEY=abcdef123456', 'credential_assignments'],
    ['postgresql://user:password@db.example/app', 'connection_strings'],
    ['diff --git a/file.ts b/file.ts\n@@ -1 +1 @@', 'source_diffs'],
    ['```ts\nconst token = 1\n```', 'source_code'],
    ['客户手机号 13800138000', 'customer_sensitive_data'],
  ])('识别敏感类别且阻断异常不回显原文：%s', (text, category) => {
    expect(detectSensitiveCategories(text)).toContain(category);
    try {
      sanitizeWeeklyAiInput(
        input({ baseFields: { ...baseFields(), recentGoals: `普通文字 ${text}` } }),
      );
      throw new Error('应当阻断');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('AI_INPUT_SECURITY_BLOCKED');
      const details = domainError.options.details;
      if (!details || typeof details !== 'object' || !('categories' in details)) {
        throw new Error('安全阻断缺少类别');
      }
      const categories = details.categories;
      expect(Array.isArray(categories)).toBe(true);
      expect(categories).toContain(category);
      expect(domainError.message).not.toContain(text);
    }
  });

  it('构造带版本的严格结构化请求，且协议请求中只有白名单输入', () => {
    const sanitized = sanitizeWeeklyAiInput(input());
    const request = buildWeeklyAiGenerationRequest(sanitized);

    expect(request.userPrompt).toContain(weeklyAiPromptTemplateVersion);
    expect(request.userPrompt).toContain(weeklyAiSanitizationPolicyVersion);
    expect(request.systemPrompt).toContain('不能补充、推断或编造');
    expect(request.systemPrompt).toContain('completionPercent');
    expect(request.systemPrompt).toContain('parentTitle');
    expect(request.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { fields: { minItems: 1, maxItems: 1 } },
    });
    expect(request.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('允许空白周报栏位使用任务事实生成，不再把空栏位当作安全错误', () => {
    const sanitized = sanitizeWeeklyAiInput(
      input({ baseFields: { ...baseFields(), recentGoals: '   ' } }),
    );

    expect(sanitized.storedReferences).toHaveLength(1);
    expect(sanitized.storedReferences[0]?.sourceType).toBe('task');
    expect(sanitized.inputCategories).toEqual(['jira_metadata']);
  });

  it('没有任何可引用事实时给出明确的空输入错误', () => {
    expect(() =>
      sanitizeWeeklyAiInput(
        input({
          baseFields: { ...baseFields(), recentGoals: '' },
          tasks: [],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'AI_SANITIZED_INPUT_EMPTY' }));
  });

  it('只接受被段落引用直接支持的工单号、日期、数字和项目名', () => {
    const sanitized = sanitizeWeeklyAiInput(input());
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const valid = JSON.stringify({
      fields: [
        {
          field: 'recentGoals',
          paragraphs: [
            {
              projectName: 'Alpha',
              text: `推进 Alpha 项目 AW-12，完成完整实现 AI 建议，已投入 2 小时，截止 2026-07-18。[citation:${taskRef}]`,
              citations: [taskRef],
            },
          ],
        },
      ],
    });
    const result = validateWeeklyAiOutput(valid, sanitized, baseFields());

    expect(result.fieldTexts.recentGoals).toContain('1、推进 Alpha 项目 完成完整实现 AI 建议');
    expect(result.fieldTexts.recentGoals).not.toContain('AW-12');
    expect(result.fieldTexts.recentGoals).not.toContain('[citation:');
    expect(result.fields[0]?.paragraphs[0]?.citations).toEqual([taskRef]);
    expect(result.fieldTexts.weeklyWork).toBe('本周原始工作');
  });

  it('接受引用正文中明确出现的项目名，即使来源没有独立 projectName 字段', () => {
    const fields = { ...baseFields(), recentGoals: '推进凤凰平台的周报生成能力。' };
    const sanitized = sanitizeWeeklyAiInput(input({ baseFields: fields, tasks: [] }));
    const baseRef = sanitized.storedReferences[0]!.refId;
    const raw = JSON.stringify({
      fields: [
        {
          field: 'recentGoals',
          paragraphs: [
            {
              projectName: '凤凰平台',
              text: '推进凤凰平台的周报生成能力。',
              citations: [baseRef],
            },
          ],
        },
      ],
    });

    expect(validateWeeklyAiOutput(raw, sanitized, fields).fieldTexts.recentGoals).toBe(
      '1、推进凤凰平台的周报生成能力。',
    );
  });

  it('AI 无有效内容时保留模板基线，有内容时才用编号后的优化结果覆盖', () => {
    const sanitized = sanitizeWeeklyAiInput(input({ selectedFields: ['problems'] }));
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const placeholder = JSON.stringify({
      fields: [
        {
          field: 'problems',
          paragraphs: [{ projectName: null, text: '无明确问题。', citations: [taskRef] }],
        },
      ],
    });
    expect(validateWeeklyAiOutput(placeholder, sanitized, baseFields()).fieldTexts.problems).toBe(
      '暂无',
    );
    expect(
      validateWeeklyAiOutput(placeholder, sanitized, baseFields()).fields[0]?.paragraphs,
    ).toEqual([]);

    const empty = JSON.stringify({ fields: [{ field: 'problems', paragraphs: [] }] });
    expect(validateWeeklyAiOutput(empty, sanitized, baseFields()).fieldTexts.problems).toBe('暂无');
  });

  it('归一化 JSON Object 模式返回的字段对象和缺省项目名', () => {
    const sanitized = sanitizeWeeklyAiInput(
      input({ selectedFields: ['recentGoals', 'weeklyWork'] }),
    );
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const raw = JSON.stringify({
      recentGoals: { paragraphs: [] },
      weeklyWork: {
        paragraphs: [{ text: '推进 Alpha 项目 AW-12，已投入 2 小时。', citations: [taskRef] }],
      },
    });

    const result = validateWeeklyAiOutput(raw, sanitized, baseFields());

    expect(result.fields[1]?.paragraphs[0]?.projectName).toBeNull();
    expect(result.fields[1]?.paragraphs[0]).toMatchObject({
      parentTitle: 'Alpha 父任务',
      completionPercent: 50,
    });
    expect(result.fieldTexts.recentGoals).toBe(baseFields().recentGoals);
    expect(result.fieldTexts.weeklyWork).toBe(
      '【Alpha 父任务】\n1、实现完整周报 AI本周持续推进（完成度 50%）',
    );
  });

  it('优先使用 Sprint 父级分组，并保留 Jira 父任务与具体子任务层级', () => {
    const sanitized = sanitizeWeeklyAiInput(
      input({
        selectedFields: ['weeklyWork'],
        tasks: [
          {
            ...task(),
            parentTitle: '【需求】 +【】运营后台重制密码功能',
            rootParentTitle: '编辑器交互调整',
            sprintNames: ['P_uTwin_20260727_HQ_【空间联通交互升级】'],
            title: '【前端】 +【】前端界面开发',
          },
        ],
      }),
    );
    const taskSource = sanitized.sanitizedInput.sources.find((source) => source.kind === 'task');
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;

    expect(taskSource).toMatchObject({
      parentTitle: '空间联通交互升级',
      taskParentTitle: '运营后台重制密码功能',
      title: '前端界面开发',
      weeklyWorkEligible: true,
    });
    expect(taskSource).not.toHaveProperty('rootParentTitle');
    expect(taskSource).not.toHaveProperty('sprintNames');

    const result = validateWeeklyAiOutput(
      JSON.stringify({
        fields: [
          {
            field: 'weeklyWork',
            paragraphs: [
              {
                text: '错误父级：前端界面开发本周持续推进',
                citations: [taskRef],
              },
            ],
          },
        ],
      }),
      sanitized,
      baseFields(),
    );

    expect(result.fieldTexts.weeklyWork).toBe(
      '【空间联通交互升级】\n1、运营后台重制密码功能——前端界面开发本周持续推进（完成度 50%）',
    );
  });

  it('拒绝把未填写本周期工时的任务写入本周工作', () => {
    const unloggedTask = {
      ...task(),
      id: 'task-unlogged',
      issueKey: 'AW-13',
      title: '未填写工时的任务',
      timeSpentSeconds: null,
    } satisfies WeeklyTaskFact;
    const sanitized = sanitizeWeeklyAiInput(
      input({ selectedFields: ['weeklyWork'], tasks: [task(), unloggedTask] }),
    );
    const references = sanitized.storedReferences.filter((item) => item.sourceType === 'task');
    const loggedRef = references.find((item) => item.sourceId === 'task-1')!.refId;
    const unloggedRef = references.find((item) => item.sourceId === 'task-unlogged')!.refId;
    const raw = JSON.stringify({
      fields: [
        {
          field: 'weeklyWork',
          paragraphs: [
            { text: '实现完整周报 AI本周持续推进', citations: [loggedRef] },
            { text: '未填写工时的任务本周持续推进', citations: [unloggedRef] },
          ],
        },
      ],
    });

    expect(
      sanitized.sanitizedInput.sources.find(
        (source) => source.kind === 'task' && source.issueKey === 'AW-13',
      ),
    ).toMatchObject({ weeklyWorkEligible: false });

    expect(() => validateWeeklyAiOutput(raw, sanitized, baseFields())).toThrowError(
      expect.objectContaining({ code: 'AI_OUTPUT_WEEKLY_WORK_WITHOUT_WORKLOG' }),
    );
  });

  it('AI 非空本周工作必须完整覆盖全部工时任务', () => {
    const secondLoggedTask = {
      ...task(),
      id: 'task-2',
      issueKey: 'AW-13',
      title: '第二个工时任务',
    } satisfies WeeklyTaskFact;
    const sanitized = sanitizeWeeklyAiInput(
      input({ selectedFields: ['weeklyWork'], tasks: [task(), secondLoggedTask] }),
    );
    const loggedRef = sanitized.storedReferences.find(
      (item) => item.sourceType === 'task' && item.sourceId === 'task-1',
    )!.refId;
    const raw = JSON.stringify({
      fields: [
        {
          field: 'weeklyWork',
          paragraphs: [{ text: '实现完整周报 AI本周持续推进', citations: [loggedRef] }],
        },
      ],
    });

    expect(() => validateWeeklyAiOutput(raw, sanitized, baseFields())).toThrowError(
      expect.objectContaining({ code: 'AI_OUTPUT_WEEKLY_WORK_TASK_SET_INVALID' }),
    );
  });

  it.each([
    ['AI_OUTPUT_CITATION_UNKNOWN', { citations: ['ref_not_in_this_request'] }],
    ['AI_OUTPUT_NUMBER_UNSUPPORTED', { text: '推进 Alpha 项目 AW-12，已投入 3 小时。' }],
    ['AI_OUTPUT_ISSUE_UNSUPPORTED', { text: '推进 Alpha 项目 AW-999，已投入 2 小时。' }],
    ['AI_OUTPUT_DATE_UNSUPPORTED', { text: '推进 Alpha 项目 AW-12，截止 2027-01-01。' }],
    ['AI_OUTPUT_ACTIVE_CONTENT_REJECTED', { text: '<script>alert(1)</script>' }],
    [
      'AI_OUTPUT_SECURITY_BLOCKED',
      { text: 'Authorization: Bearer provider-invented-secret-value' },
    ],
  ])('拒绝无依据或主动内容：%s', (code, override) => {
    const sanitized = sanitizeWeeklyAiInput(input());
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const raw = JSON.stringify({
      fields: [
        {
          field: 'recentGoals',
          paragraphs: [
            {
              projectName: 'Alpha',
              text: '推进 Alpha 项目 AW-12，已投入 2 小时。',
              citations: [taskRef],
              ...override,
            },
          ],
        },
      ],
    });
    expect(() => validateWeeklyAiOutput(raw, sanitized, baseFields())).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('清空无引用依据的项目标签，但保留通过事实校验的正文', () => {
    const sanitized = sanitizeWeeklyAiInput(input());
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const raw = JSON.stringify({
      fields: [
        {
          field: 'recentGoals',
          paragraphs: [
            {
              projectName: 'Imaginary',
              text: '推进 Alpha 项目 AW-12，已投入 2 小时。',
              citations: [taskRef],
            },
          ],
        },
      ],
    });

    const result = validateWeeklyAiOutput(raw, sanitized, baseFields());
    expect(result.fields[0]?.paragraphs[0]?.projectName).toBeNull();
    expect(result.fieldTexts.recentGoals).toBe('1、推进 Alpha 项目 已投入 2 小时。');
  });

  it('拒绝字段缺失、重复和额外动作结构', () => {
    const sanitized = sanitizeWeeklyAiInput(input());
    const taskRef = sanitized.storedReferences.find((item) => item.sourceType === 'task')!.refId;
    const paragraph = { projectName: 'Alpha', text: '推进 Alpha 项目 AW-12', citations: [taskRef] };

    expect(() =>
      validateWeeklyAiOutput(
        JSON.stringify({ fields: [{ field: 'weeklyWork', paragraphs: [paragraph] }] }),
        sanitized,
        baseFields(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'AI_OUTPUT_FIELD_SET_INVALID' }));
    expect(() =>
      validateWeeklyAiOutput(
        JSON.stringify({
          fields: [{ field: 'recentGoals', paragraphs: [paragraph] }],
          action: { type: 'send_dingtalk' },
        }),
        sanitized,
        baseFields(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'AI_OUTPUT_SCHEMA_INVALID' }));
  });

  function input(
    override: Partial<{
      tasks: WeeklyTaskFact[];
      evidence: WeeklyEvidenceFact[];
      manualInputs: WeeklyManualInput[];
      baseFields: Record<WeeklyReportField, string>;
      selectedFields: WeeklyReportField[];
      consent: {
        allowPeopleNames: boolean;
        allowInternalUrls: boolean;
        allowDescriptionSummaries: boolean;
      };
    }> = {},
  ) {
    return {
      periodStart: '2026-07-13',
      periodEnd: '2026-07-19',
      reportDate: '2026-07-18',
      timezone: 'Asia/Shanghai',
      selectedFields: override.selectedFields ?? (['recentGoals'] as WeeklyReportField[]),
      baseFields: override.baseFields ?? baseFields(),
      tasks: override.tasks ?? [task()],
      evidence: override.evidence ?? [],
      manualInputs: override.manualInputs ?? [],
      consent: override.consent ?? {
        allowPeopleNames: false,
        allowInternalUrls: false,
        allowDescriptionSummaries: false,
      },
    };
  }

  function baseFields(): Record<WeeklyReportField, string> {
    return {
      recentGoals: '推进 Alpha 项目 AW-12，截止 2026-07-18，预计 2 小时。',
      weeklyWork: '本周原始工作',
      nextWeekPlans: '下周原始计划',
      problems: '暂无',
      other: '无',
    };
  }

  function task(): WeeklyTaskFact {
    return {
      id: 'task-1',
      issueKey: 'AW-12',
      projectId: 'project-1',
      projectName: 'Alpha',
      parentTitle: 'Alpha 父任务',
      title: '实现完整周报 AI',
      normalizedStatus: 'in_progress',
      plannedStartDate: '2026-07-13',
      dueDate: '2026-07-18',
      timeSpentSeconds: 7_200,
      originalEstimateSeconds: 7_200,
      remainingEstimateSeconds: 3_600,
      sprintActive: true,
      isCurrentUser: true,
      visibilityState: 'visible',
      lastObservedAt: '2026-07-18T01:00:00.000Z',
      sourceFreshness: 'fresh',
    };
  }
});
