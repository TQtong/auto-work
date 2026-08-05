import { describe, expect, it } from 'vitest';
import {
  generateWeeklyReportRuleDraft,
  type GenerateWeeklyReportRuleInput,
  type WeeklyTaskFact,
} from '../src/lib/weekly-report-rules.js';

const task = (id: string, overrides: Partial<WeeklyTaskFact> = {}): WeeklyTaskFact => ({
  id,
  issueKey: `PROJ-${id}`,
  projectId: 'project-1',
  projectName: '研发平台',
  title: `任务 ${id}`,
  normalizedStatus: 'in_progress',
  priority: 'medium',
  plannedStartDate: '2026-07-13',
  dueDate: '2026-07-20',
  timeSpentSeconds: null,
  originalEstimateSeconds: null,
  remainingEstimateSeconds: null,
  sprintActive: true,
  isCurrentUser: true,
  visibilityState: 'visible',
  lastObservedAt: '2026-07-17T09:00:00+08:00',
  sourceFreshness: 'fresh',
  ...overrides,
});

function input(
  overrides: Partial<GenerateWeeklyReportRuleInput> = {},
): GenerateWeeklyReportRuleInput {
  return {
    periodStart: '2026-07-13',
    periodEnd: '2026-07-17',
    reportDate: '2026-07-17',
    timezone: 'Asia/Shanghai',
    calendarVersion: 'calendar-v1',
    tasks: [],
    evidence: [],
    manualInputs: [],
    ...overrides,
  };
}

describe('六字段周报确定性规则', () => {
  it('按任务状态生成目标、本周、计划和问题，并保持空工时为 null', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [
          task('1', {
            normalizedStatus: 'done',
            parentTitle: '贵安漏洞修复',
            sprintActive: false,
            timeSpentSeconds: 3_600,
            statusChangedAt: '2026-07-17T00:30:00+08:00',
          }),
          task('2', {
            normalizedStatus: 'blocked',
            parentTitle: '编辑器交互调整',
            priority: 'highest',
            dueDate: '2026-07-16',
            timeSpentSeconds: 14_400,
            originalEstimateSeconds: 57_600,
            remainingEstimateSeconds: 28_800,
          }),
          task('3', {
            normalizedStatus: 'cancelled',
            timeSpentSeconds: 1_800,
            statusChangedAt: '2026-07-16T10:00:00+08:00',
          }),
          task('4', { isCurrentUser: false }),
          task('5', { visibilityState: 'out_of_scope' }),
        ],
      }),
    );

    expect(draft.fields.recentGoals.map((block) => block.body)).toEqual([
      expect.stringContaining('任务 2'),
    ]);
    expect(draft.fields.weeklyWork.map((block) => block.body)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('任务 1'),
        expect.stringContaining('任务 2'),
        expect.stringContaining('任务 3'),
      ]),
    );
    expect(
      draft.fields.weeklyWork.find((block) => block.body.includes('任务 1'))?.actualHours,
    ).toBe(1);
    expect(
      draft.fields.weeklyWork.find((block) => block.body.includes('任务 2'))?.actualHours,
    ).toBe(4);
    const completedWork = draft.fields.weeklyWork.find((block) => block.body.includes('任务 1'));
    expect(completedWork?.title).toBe('贵安漏洞修复');
    expect(completedWork?.body).toContain('完成度 100%');
    const blockedWork = draft.fields.weeklyWork.find((block) => block.body.includes('任务 2'));
    expect(blockedWork?.title).toBe('编辑器交互调整');
    expect(blockedWork?.body).toContain('完成度 50%');
    expect(draft.fields.nextWeekPlans.some((block) => block.body.includes('任务 3'))).toBe(false);
    expect(draft.fields.nextWeekPlans.find((block) => block.body.includes('任务 2'))).toMatchObject(
      {
        estimatedHours: 8,
      },
    );
    expect(draft.fields.problems[0]?.body).toContain('任务受阻');
    expect(draft.sourceIds.taskIds).toEqual(['1', '2', '3']);
  });

  it('为周报本周工作保留根父级分组，并输出子任务层级和完成度', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [
          task('child-1', {
            title: '[前端] + [ ] 前端界面开发',
            parentTitle: '运营后台重制密码功能',
            sprintNames: ['P_uTwin_20260727_HQ_【空间联通交互升级】'],
            normalizedStatus: 'done',
            timeSpentSeconds: 7_200,
          }),
          task('child-2', {
            title: '右键菜单重构-分组',
            parentTitle: '右键菜单交互优化',
            sprintNames: ['P_uTwin_20260727_HQ_【空间联通交互升级】'],
            normalizedStatus: 'in_progress',
            timeSpentSeconds: 3_600,
          }),
        ],
      }),
    );

    expect(draft.fields.weeklyWork).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '空间联通交互升级',
          body: '运营后台重制密码功能——前端界面开发已完成并形成结果（完成度 100%）',
        }),
        expect.objectContaining({
          title: '空间联通交互升级',
          body: '右键菜单交互优化——右键菜单重构-分组本周持续推进（完成度 50%）',
        }),
      ]),
    );
  });

  it('仅记录本周期工时时也应生成本周工作', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [
          task('worklog-only', {
            lastObservedAt: '2026-07-01T09:00:00+08:00',
            timeSpentSeconds: 3_600,
          }),
        ],
      }),
    );

    const work = draft.fields.weeklyWork.find((block) =>
      block.sourceRefs.some(
        (reference) => reference.type === 'task' && reference.id === 'worklog-only',
      ),
    );
    expect(work?.body).toContain('任务 worklog-only');
    expect(work?.actualHours).toBe(1);
  });

  it('没有本周期工时的任务即使同步、变更状态或关联证据也不进入本周工作', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [
          task('unlogged', {
            statusChangedAt: '2026-07-16T10:00:00+08:00',
            timeSpentSeconds: null,
          }),
        ],
        evidence: [
          {
            id: 'unlogged-commit',
            taskId: 'unlogged',
            sourceType: 'commit',
            title: '未填写工时任务的提交',
            eventAt: '2026-07-16T09:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
          },
        ],
      }),
    );

    expect(draft.fields.weeklyWork).toEqual([]);
  });

  it('聚合同一任务的多个 Commit，不逐条复制 message，并把失败 Pipeline 放入问题字段', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [task('1', { timeSpentSeconds: 3_600 })],
        evidence: [
          {
            id: 'commit-b',
            taskId: '1',
            projectId: 'project-1',
            sourceType: 'commit',
            title: '第二条内部实现 message',
            eventAt: '2026-07-15T09:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
          },
          {
            id: 'commit-a',
            taskId: '1',
            projectId: 'project-1',
            sourceType: 'commit',
            title: '第一条内部实现 message',
            eventAt: '2026-07-14T09:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
          },
          {
            id: 'pipeline-failed',
            taskId: '1',
            projectId: 'project-1',
            sourceType: 'pipeline',
            title: '流水线 42',
            eventAt: '2026-07-16T09:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
            pipelineStatus: 'failed',
          },
        ],
      }),
    );

    const work = draft.fields.weeklyWork[0];
    expect(work?.body).toContain('2 项Commit');
    expect(work?.body).toContain('1 项Pipeline');
    expect(work?.body).not.toContain('内部实现 message');
    expect(work?.sourceRefs.filter((ref) => ref.type === 'evidence')).toHaveLength(3);
    expect(draft.fields.problems.some((block) => block.title === 'Pipeline 失败')).toBe(true);
    expect(draft.fields.problems.find((block) => block.title === 'Pipeline 失败')?.body).toContain(
      '不能表述为已发布',
    );
  });

  it('没有问题时保持空白，并保留人工置顶目标和其他补充', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [task('1', { normalizedStatus: 'done', sprintActive: false })],
        manualInputs: [
          { id: 'manual-goal', field: 'recentGoals', text: '完成架构评审', pinned: true },
          { id: 'manual-other', field: 'other', text: '参与跨组技术分享' },
        ],
      }),
    );

    expect(draft.fields.problems).toEqual([]);
    expect(draft.fields.recentGoals[0]).toMatchObject({ body: '完成架构评审', pinned: true });
    expect(draft.fields.other[0]?.body).toBe('参与跨组技术分享');
  });

  it('把日历回退、来源过期/不可用和未确认证据显式写入警告', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        calendarVersion: null,
        tasks: [
          task('1', { sourceFreshness: 'stale' }),
          task('2', { sourceFreshness: 'unavailable' }),
        ],
        evidence: [
          {
            id: 'suggested-commit',
            taskId: '1',
            sourceType: 'commit',
            title: '待确认证据',
            eventAt: '2026-07-14T09:00:00+08:00',
            relationStatus: 'suggested',
            revalidationState: 'valid',
            availabilityState: 'stale',
          },
          {
            id: 'unavailable-release',
            taskId: '2',
            sourceType: 'release',
            title: '不可用发布证据',
            eventAt: '2026-07-15T09:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'needs_revalidation',
            availabilityState: 'unavailable',
          },
        ],
      }),
    );
    expect(draft.warnings.map((warning) => warning.code)).toEqual([
      'SOURCE_STALE',
      'SOURCE_STALE',
      'SOURCE_UNAVAILABLE',
      'SOURCE_UNAVAILABLE',
      'UNCONFIRMED_EVIDENCE',
      'WORKDAY_CALENDAR_FALLBACK',
    ]);
    expect(draft.warnings.every((warning) => warning.blocking === false)).toBe(true);
  });

  it('相同来源快照不受输入数组顺序影响，得到稳定块 ID 和内容哈希', () => {
    const tasks = [task('1'), task('2', { priority: 'high' })];
    const evidence: GenerateWeeklyReportRuleInput['evidence'] = [
      {
        id: 'evidence-a',
        taskId: '1',
        sourceType: 'commit',
        title: 'A',
        eventAt: '2026-07-14T09:00:00+08:00',
        relationStatus: 'confirmed',
        revalidationState: 'valid',
        availabilityState: 'available',
      },
      {
        id: 'evidence-b',
        taskId: '1',
        sourceType: 'merge_request',
        title: 'B',
        eventAt: '2026-07-15T09:00:00+08:00',
        relationStatus: 'confirmed',
        revalidationState: 'valid',
        availabilityState: 'available',
      },
    ];
    const first = generateWeeklyReportRuleDraft(input({ tasks, evidence }));
    const second = generateWeeklyReportRuleDraft(
      input({ tasks: [...tasks].reverse(), evidence: [...evidence].reverse() }),
    );
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.fields).toEqual(first.fields);
  });

  it('严格拒绝非法周期、越界填写日期、非上海时区、重复来源和空人工输入', () => {
    expect(() =>
      generateWeeklyReportRuleDraft(input({ periodStart: '2026-07-18', periodEnd: '2026-07-17' })),
    ).toThrow('周报周期开始日期不能晚于结束日期');
    expect(() => generateWeeklyReportRuleDraft(input({ reportDate: '2026-07-25' }))).toThrow(
      '周报填写日期必须位于本周期或其后七天内',
    );
    expect(() => generateWeeklyReportRuleDraft(input({ timezone: 'UTC' }))).toThrow(
      '首版周报只支持 Asia/Shanghai',
    );
    expect(() => generateWeeklyReportRuleDraft(input({ tasks: [task('1'), task('1')] }))).toThrow(
      '任务来源 ID 不能重复',
    );
    expect(() =>
      generateWeeklyReportRuleDraft(
        input({ manualInputs: [{ id: 'empty', field: 'other', text: '  ' }] }),
      ),
    ).toThrow('人工周报输入不能为空');
  });

  it('使用上海零点作为周期边界，不遗漏周一凌晨或纳入下周数据', () => {
    const draft = generateWeeklyReportRuleDraft(
      input({
        tasks: [
          task('1', {
            lastObservedAt: '2026-07-13T00:15:00+08:00',
            timeSpentSeconds: 3_600,
          }),
        ],
        evidence: [
          {
            id: 'inside',
            taskId: '1',
            sourceType: 'commit',
            title: '周一凌晨',
            eventAt: '2026-07-13T00:05:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
          },
          {
            id: 'outside',
            taskId: '1',
            sourceType: 'commit',
            title: '下周一',
            eventAt: '2026-07-20T00:00:00+08:00',
            relationStatus: 'confirmed',
            revalidationState: 'valid',
            availabilityState: 'available',
          },
        ],
      }),
    );
    expect(draft.sourceIds.evidenceIds).toEqual(['inside']);
    expect(draft.fields.weeklyWork[0]?.sourceRefs).toContainEqual({
      type: 'evidence',
      id: 'inside',
    });
  });
});
