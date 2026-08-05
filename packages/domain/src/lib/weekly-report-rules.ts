import { DomainError } from '@auto-work/contracts';
import { requestHash } from './hash.js';

export const weeklyReportRuleVersion = 'weekly-report-rule-v2';

export type WeeklyReportField =
  'recentGoals' | 'weeklyWork' | 'nextWeekPlans' | 'problems' | 'other';
export type WeeklyTaskStatus =
  'planned' | 'in_progress' | 'blocked' | 'done' | 'cancelled' | 'other';

export interface WeeklyTaskFact {
  id: string;
  issueKey?: string | null;
  projectId?: string | null;
  projectName: string;
  parentTaskId?: string | null;
  parentTitle?: string | null;
  rootParentTaskId?: string | null;
  rootParentIssueKey?: string | null;
  rootParentTitle?: string | null;
  sprintNames?: string[];
  title: string;
  normalizedStatus: WeeklyTaskStatus;
  priority?: string | null;
  plannedStartDate?: string | null;
  dueDate?: string | null;
  timeSpentSeconds?: number | null;
  originalEstimateSeconds?: number | null;
  remainingEstimateSeconds?: number | null;
  sprintActive?: boolean;
  isCurrentUser: boolean;
  visibilityState: 'visible' | 'out_of_scope' | 'unavailable';
  lastObservedAt: string;
  statusChangedAt?: string | null;
  sourceFreshness: 'fresh' | 'stale' | 'unavailable';
}

export interface WeeklyEvidenceFact {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  sourceType: 'branch' | 'commit' | 'merge_request' | 'pipeline' | 'tag' | 'release' | 'manual';
  title: string;
  url?: string | null;
  eventAt?: string | null;
  relationStatus: 'suggested' | 'confirmed' | 'rejected' | 'expired';
  revalidationState: 'valid' | 'needs_revalidation';
  availabilityState: 'available' | 'stale' | 'unavailable';
  pipelineStatus?: string | null;
}

export interface WeeklyManualInput {
  id: string;
  field: WeeklyReportField;
  text: string;
  projectName?: string | null;
  pinned?: boolean;
}

export interface GenerateWeeklyReportRuleInput {
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  timezone: string;
  calendarVersion?: string | null;
  tasks: WeeklyTaskFact[];
  evidence: WeeklyEvidenceFact[];
  manualInputs: WeeklyManualInput[];
}

export interface WeeklyReportSourceRef {
  type: 'task' | 'evidence' | 'manual';
  id: string;
}

export interface WeeklyReportBlock {
  id: string;
  field: WeeklyReportField;
  projectName: string | null;
  title: string;
  body: string;
  sourceRefs: WeeklyReportSourceRef[];
  actualHours: number | null;
  estimatedHours: number | null;
  pinned: boolean;
  sortKey: string;
}

export interface WeeklyReportWarning {
  code:
    'WORKDAY_CALENDAR_FALLBACK' | 'SOURCE_STALE' | 'SOURCE_UNAVAILABLE' | 'UNCONFIRMED_EVIDENCE';
  message: string;
  sourceRefs: WeeklyReportSourceRef[];
  blocking: false;
}

export interface WeeklyReportRuleDraft {
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  timezone: string;
  ruleVersion: string;
  fields: Record<WeeklyReportField, WeeklyReportBlock[]>;
  warnings: WeeklyReportWarning[];
  sourceIds: { taskIds: string[]; evidenceIds: string[]; manualInputIds: string[] };
  contentHash: string;
}

const completedStatuses = new Set<WeeklyTaskStatus>(['done', 'cancelled']);
const shanghaiOffsetMilliseconds = 8 * 3_600_000;
const priorityRank: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
};

/**
 * 规则引擎只消费调用方白名单化后的任务、证据和人工输入，不在领域层读取源码、diff 或外部系统。
 * 返回值完全由输入决定，便于把同一来源快照复算为相同周报版本。
 */
export function generateWeeklyReportRuleDraft(
  input: GenerateWeeklyReportRuleInput,
): WeeklyReportRuleDraft {
  const periodStart = parseBusinessDate(input.periodStart, 'periodStart');
  const periodEnd = parseBusinessDate(input.periodEnd, 'periodEnd');
  const reportDate = parseBusinessDate(input.reportDate, 'reportDate');
  if (periodStart.time > periodEnd.time) {
    throw new DomainError('WEEKLY_REPORT_PERIOD_INVALID', '周报周期开始日期不能晚于结束日期', {
      httpStatus: 422,
    });
  }
  if (reportDate.time < periodStart.time || reportDate.time > addDays(periodEnd.time, 7)) {
    throw new DomainError('WEEKLY_REPORT_DATE_INVALID', '周报填写日期必须位于本周期或其后七天内', {
      httpStatus: 422,
    });
  }
  if (input.timezone !== 'Asia/Shanghai') {
    throw new DomainError('WEEKLY_REPORT_TIMEZONE_UNSUPPORTED', '首版周报只支持 Asia/Shanghai', {
      httpStatus: 422,
    });
  }
  assertUniqueIds(input.tasks, '任务');
  assertUniqueIds(input.evidence, '证据');
  assertUniqueIds(input.manualInputs, '人工输入');

  const tasks = input.tasks.filter(
    (task) => task.isCurrentUser && task.visibilityState === 'visible',
  );
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const evidence = input.evidence.filter((item) => {
    const event = item.eventAt ? parseBusinessTimestamp(item.eventAt, 'evidence.eventAt') : null;
    return !event || (event >= periodStart.time && event < addDays(periodEnd.time, 1));
  });
  const fields: Record<WeeklyReportField, WeeklyReportBlock[]> = {
    recentGoals: [],
    weeklyWork: [],
    nextWeekPlans: [],
    problems: [],
    other: [],
  };

  appendManualBlocks(fields, input.manualInputs);
  fields.recentGoals.push(...buildGoalBlocks(tasks, periodEnd.time));
  fields.weeklyWork.push(...buildWorkBlocks(tasks, evidence));
  fields.nextWeekPlans.push(...buildPlanBlocks(tasks, periodEnd.time));
  fields.problems.push(...buildProblemBlocks(tasks, evidence, periodEnd.time));

  for (const field of Object.keys(fields) as WeeklyReportField[]) {
    fields[field] = deduplicateBlocks(fields[field]).sort(compareBlocks);
  }
  const warnings = buildWarnings(tasks, evidence, taskById, Boolean(input.calendarVersion));
  const sourceIds = {
    taskIds: [...new Set(tasks.map((task) => task.id))].sort(),
    evidenceIds: [...new Set(evidence.map((item) => item.id))].sort(),
    manualInputIds: [...new Set(input.manualInputs.map((item) => item.id))].sort(),
  };
  const withoutHash = {
    periodStart: periodStart.value,
    periodEnd: periodEnd.value,
    reportDate: reportDate.value,
    timezone: input.timezone,
    ruleVersion: weeklyReportRuleVersion,
    fields,
    warnings,
    sourceIds,
  };
  return { ...withoutHash, contentHash: requestHash(withoutHash) };
}

function buildGoalBlocks(tasks: WeeklyTaskFact[], periodEnd: number): WeeklyReportBlock[] {
  const horizon = addDays(periodEnd, 14);
  const candidates = tasks.filter((task) => {
    if (completedStatuses.has(task.normalizedStatus)) return false;
    const start = task.plannedStartDate
      ? parseBusinessDate(task.plannedStartDate, 'plannedStartDate').time
      : null;
    const due = task.dueDate ? parseBusinessDate(task.dueDate, 'dueDate').time : null;
    return (
      task.sprintActive ||
      task.normalizedStatus === 'blocked' ||
      (start !== null && start <= horizon) ||
      (due !== null && due <= horizon)
    );
  });
  const groups = groupTasks(candidates);
  const blocks: WeeklyReportBlock[] = [];
  for (const group of groups.values()) {
    for (const task of [...group].sort(compareTasks).slice(0, 3)) {
      const expected = task.dueDate ? `，预期在 ${task.dueDate} 前完成` : '';
      blocks.push(
        makeBlock(
          'recentGoals',
          task.projectName,
          taskGroupTitle(task),
          `推进${displayTask(task)}${expected}`,
          [{ type: 'task', id: task.id }],
          null,
          secondsToHours(task.remainingEstimateSeconds ?? task.originalEstimateSeconds),
          false,
          taskSortKey(task),
        ),
      );
    }
  }
  return blocks;
}

function buildWorkBlocks(
  tasks: WeeklyTaskFact[],
  evidence: WeeklyEvidenceFact[],
): WeeklyReportBlock[] {
  const blocks: WeeklyReportBlock[] = [];
  for (const task of tasks) {
    // timeSpentSeconds 是服务层按当前周报周期、当前用户汇总后的工时；本周工作严格以它为准。
    if (!weeklyTaskHasWorklog(task)) continue;
    const taskEvidence = evidence
      .filter((item) => item.taskId === task.id && item.relationStatus === 'confirmed')
      .sort((left, right) => left.id.localeCompare(right.id));
    const evidenceKinds = summarizeEvidenceKinds(taskEvidence);
    const statusText =
      task.normalizedStatus === 'done'
        ? '已完成并形成结果'
        : task.normalizedStatus === 'blocked'
          ? '已推进但当前受阻'
          : '本周持续推进';
    const evidenceText = evidenceKinds ? `，关联${evidenceKinds}` : '';
    const groupTitle = workGroupTitle(task);
    const workTitle = workItemTitle(task, groupTitle);
    const completion = weeklyTaskCompletionPercent(task);
    blocks.push(
      makeBlock(
        'weeklyWork',
        task.projectName,
        groupTitle ?? task.projectName,
        `${workTitle}${statusText}${evidenceText}（完成度 ${completion}%）`,
        [
          { type: 'task', id: task.id },
          ...taskEvidence.map((item): WeeklyReportSourceRef => ({ type: 'evidence', id: item.id })),
        ],
        secondsToHours(task.timeSpentSeconds),
        secondsToHours(task.originalEstimateSeconds),
        false,
        taskSortKey(task),
      ),
    );
  }
  return blocks;
}

function buildPlanBlocks(tasks: WeeklyTaskFact[], periodEnd: number): WeeklyReportBlock[] {
  const nextWeekEnd = addDays(periodEnd, 7);
  return tasks
    .filter((task) => {
      if (completedStatuses.has(task.normalizedStatus)) return false;
      const start = task.plannedStartDate
        ? parseBusinessDate(task.plannedStartDate, 'plannedStartDate').time
        : null;
      const due = task.dueDate ? parseBusinessDate(task.dueDate, 'dueDate').time : null;
      return (
        task.sprintActive ||
        task.normalizedStatus === 'in_progress' ||
        (start !== null && start > periodEnd && start <= nextWeekEnd) ||
        (due !== null && due <= nextWeekEnd)
      );
    })
    .sort(compareTasks)
    .map((task) => {
      const overdue = task.dueDate
        ? parseBusinessDate(task.dueDate, 'dueDate').time < periodEnd
        : false;
      const verb = overdue
        ? '继续收尾'
        : task.normalizedStatus === 'in_progress'
          ? '继续推进'
          : '计划开展';
      const completion = task.dueDate ? `，预期完成点 ${task.dueDate}` : '';
      return makeBlock(
        'nextWeekPlans',
        task.projectName,
        taskGroupTitle(task),
        `${verb}${displayTask(task)}${completion}`,
        [{ type: 'task', id: task.id }],
        null,
        secondsToHours(task.remainingEstimateSeconds ?? task.originalEstimateSeconds),
        false,
        taskSortKey(task),
      );
    });
}

function buildProblemBlocks(
  tasks: WeeklyTaskFact[],
  evidence: WeeklyEvidenceFact[],
  periodEnd: number,
): WeeklyReportBlock[] {
  const blocks: WeeklyReportBlock[] = [];
  for (const task of tasks) {
    const overdue = task.dueDate
      ? parseBusinessDate(task.dueDate, 'dueDate').time < periodEnd &&
        !completedStatuses.has(task.normalizedStatus)
      : false;
    if (task.normalizedStatus !== 'blocked' && !overdue) continue;
    const problem = task.normalizedStatus === 'blocked' ? '任务受阻' : '任务已逾期未完成';
    blocks.push(
      makeBlock(
        'problems',
        task.projectName,
        taskGroupTitle(task),
        `${problem}：${displayTask(task)}；影响：可能影响计划完成时间；所需协助/下一步：请人工补充具体依赖与责任方`,
        [{ type: 'task', id: task.id }],
        null,
        null,
        false,
        taskSortKey(task),
      ),
    );
  }
  for (const item of evidence) {
    if (
      item.sourceType !== 'pipeline' ||
      item.relationStatus !== 'confirmed' ||
      item.pipelineStatus?.toLowerCase() !== 'failed'
    ) {
      continue;
    }
    const task = item.taskId ? tasks.find((candidate) => candidate.id === item.taskId) : undefined;
    blocks.push(
      makeBlock(
        'problems',
        task?.projectName ?? null,
        'Pipeline 失败',
        `问题：${task ? displayTask(task) : '关联交付'}的 Pipeline 失败；影响：当前不能表述为已发布；所需协助/下一步：检查失败原因并重新验证`,
        [
          ...(task ? ([{ type: 'task', id: task.id }] as WeeklyReportSourceRef[]) : []),
          { type: 'evidence', id: item.id },
        ],
        null,
        null,
        false,
        `pipeline:${item.id}`,
      ),
    );
  }
  return blocks;
}

function appendManualBlocks(
  fields: Record<WeeklyReportField, WeeklyReportBlock[]>,
  inputs: WeeklyManualInput[],
): void {
  for (const item of inputs) {
    const text = item.text.trim();
    if (!text) {
      throw new DomainError('WEEKLY_REPORT_MANUAL_INPUT_EMPTY', '人工周报输入不能为空', {
        httpStatus: 422,
      });
    }
    fields[item.field].push(
      makeBlock(
        item.field,
        item.projectName?.trim() || null,
        '人工补充',
        text,
        [{ type: 'manual', id: item.id }],
        null,
        null,
        item.pinned ?? false,
        `manual:${item.id}`,
      ),
    );
  }
}

function buildWarnings(
  tasks: WeeklyTaskFact[],
  evidence: WeeklyEvidenceFact[],
  taskById: Map<string, WeeklyTaskFact>,
  hasCalendarVersion: boolean,
): WeeklyReportWarning[] {
  const warnings: WeeklyReportWarning[] = [];
  if (!hasCalendarVersion) {
    warnings.push({
      code: 'WORKDAY_CALENDAR_FALLBACK',
      message: '未配置企业工作日历，当前按周一至周五计算且未应用节假日调整',
      sourceRefs: [],
      blocking: false,
    });
  }
  for (const task of tasks) {
    if (task.sourceFreshness === 'fresh') continue;
    warnings.push({
      code: task.sourceFreshness === 'stale' ? 'SOURCE_STALE' : 'SOURCE_UNAVAILABLE',
      message:
        task.sourceFreshness === 'stale'
          ? `${displayTask(task)}的任务来源不是最新数据`
          : `${displayTask(task)}的任务来源当前不可用`,
      sourceRefs: [{ type: 'task', id: task.id }],
      blocking: false,
    });
  }
  for (const item of evidence) {
    if (item.availabilityState !== 'available') {
      warnings.push({
        code: item.availabilityState === 'stale' ? 'SOURCE_STALE' : 'SOURCE_UNAVAILABLE',
        message:
          item.availabilityState === 'stale'
            ? `${sourceTypeLabel(item.sourceType)}证据不是最新数据`
            : `${sourceTypeLabel(item.sourceType)}证据来源当前不可用`,
        sourceRefs: [{ type: 'evidence', id: item.id }],
        blocking: false,
      });
    }
    if (item.relationStatus !== 'suggested') continue;
    const task = item.taskId ? taskById.get(item.taskId) : undefined;
    warnings.push({
      code: 'UNCONFIRMED_EVIDENCE',
      message: `${task ? displayTask(task) : '未关联任务'}存在待人工确认的${sourceTypeLabel(item.sourceType)}证据`,
      sourceRefs: [{ type: 'evidence', id: item.id }],
      blocking: false,
    });
  }
  return warnings.sort((left, right) =>
    `${left.code}:${left.sourceRefs[0]?.id ?? ''}`.localeCompare(
      `${right.code}:${right.sourceRefs[0]?.id ?? ''}`,
    ),
  );
}

function makeBlock(
  field: WeeklyReportField,
  projectName: string | null,
  title: string,
  body: string,
  sourceRefs: WeeklyReportSourceRef[],
  actualHours: number | null,
  estimatedHours: number | null,
  pinned: boolean,
  sortKey: string,
): WeeklyReportBlock {
  const stableIdentity = { field, sourceRefs, title, body };
  return {
    id: `weekly-block-${requestHash(stableIdentity).slice(0, 20)}`,
    field,
    projectName,
    title,
    body,
    sourceRefs,
    actualHours,
    estimatedHours,
    pinned,
    sortKey,
  };
}

function groupTasks(tasks: WeeklyTaskFact[]): Map<string, WeeklyTaskFact[]> {
  const groups = new Map<string, WeeklyTaskFact[]>();
  for (const task of tasks) {
    const key = `${task.projectId ?? task.projectName}:${task.parentTaskId ?? task.parentTitle ?? 'root'}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return groups;
}

function compareTasks(left: WeeklyTaskFact, right: WeeklyTaskFact): number {
  if (left.normalizedStatus === 'blocked' && right.normalizedStatus !== 'blocked') return -1;
  if (right.normalizedStatus === 'blocked' && left.normalizedStatus !== 'blocked') return 1;
  const priority = priorityValue(left.priority) - priorityValue(right.priority);
  if (priority !== 0) return priority;
  const due = (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31');
  if (due !== 0) return due;
  return `${left.projectName}:${left.title}:${left.id}`.localeCompare(
    `${right.projectName}:${right.title}:${right.id}`,
  );
}

function compareBlocks(left: WeeklyReportBlock, right: WeeklyReportBlock): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return `${left.projectName ?? ''}:${left.sortKey}:${left.id}`.localeCompare(
    `${right.projectName ?? ''}:${right.sortKey}:${right.id}`,
  );
}

function deduplicateBlocks(blocks: WeeklyReportBlock[]): WeeklyReportBlock[] {
  const seenManualOrSource = new Set<string>();
  return blocks.filter((block) => {
    const key =
      block.sourceRefs
        .map((ref) => `${ref.type}:${ref.id}`)
        .sort()
        .join('|') || block.id;
    if (seenManualOrSource.has(key)) return false;
    seenManualOrSource.add(key);
    return true;
  });
}

function summarizeEvidenceKinds(evidence: WeeklyEvidenceFact[]): string {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    const label = sourceTypeLabel(item.sourceType);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `${count} 项${label}`)
    .join('、');
}

function sourceTypeLabel(type: WeeklyEvidenceFact['sourceType']): string {
  return {
    branch: '分支',
    commit: 'Commit',
    merge_request: 'MR',
    pipeline: 'Pipeline',
    tag: 'Tag',
    release: 'Release',
    manual: '人工材料',
  }[type];
}

function displayTask(task: WeeklyTaskFact): string {
  return task.title;
}

function taskGroupTitle(task: WeeklyTaskFact): string {
  return task.parentTitle?.trim() || task.projectName;
}

export function weeklyTaskGroupTitle(task: WeeklyTaskFact): string | null {
  const sprintParent = (task.sprintNames ?? [])
    .map((name) => /【([^】]+)】/u.exec(name)?.[1]?.trim() ?? '')
    .find(Boolean);
  return sprintParent || task.rootParentTitle?.trim() || task.parentTitle?.trim() || null;
}

export function weeklyTaskDisplayTitle(task: WeeklyTaskFact): string {
  return cleanTaskTitle(task.title);
}

export function weeklyTaskHasWorklog(task: WeeklyTaskFact): boolean {
  return typeof task.timeSpentSeconds === 'number' && task.timeSpentSeconds > 0;
}

function workGroupTitle(task: WeeklyTaskFact): string | null {
  return weeklyTaskGroupTitle(task);
}

function workItemTitle(task: WeeklyTaskFact, groupTitle: string | null): string {
  const immediateParent = task.parentTitle?.trim();
  const cleanedTitle = weeklyTaskDisplayTitle(task);
  if (groupTitle && immediateParent && groupTitle !== immediateParent) {
    return `${cleanTaskTitle(immediateParent)}——${cleanedTitle}`;
  }
  return cleanedTitle;
}

function cleanTaskTitle(value: string): string {
  return value.replace(/^\s*(?:\[[^\]]*\]\s*(?:\+\s*)?)+/u, '').trim();
}

/**
 * 周报完成度优先使用 Jira 估算与剩余工时计算；缺少估算时才按状态给出保守值。
 * 未完成状态最多为 99%，避免仅因工时耗尽就误报已完成。
 */
export function weeklyTaskCompletionPercent(task: WeeklyTaskFact): number {
  if (task.normalizedStatus === 'done') return 100;
  if (task.normalizedStatus === 'planned' || task.normalizedStatus === 'cancelled') return 0;

  const estimated = validNonNegative(task.originalEstimateSeconds);
  const remaining = validNonNegative(task.remainingEstimateSeconds);
  const spent = validNonNegative(task.timeSpentSeconds);
  if (estimated !== null && estimated > 0) {
    const calculated =
      remaining !== null
        ? ((estimated - Math.min(estimated, remaining)) / estimated) * 100
        : spent !== null
          ? (spent / estimated) * 100
          : null;
    if (calculated !== null) return Math.min(99, Math.max(0, Math.round(calculated)));
  }
  if (task.normalizedStatus === 'in_progress' || task.normalizedStatus === 'blocked') {
    return spent !== null && spent > 0 ? 50 : 0;
  }
  return 0;
}

function validNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function taskSortKey(task: WeeklyTaskFact): string {
  return `${String(priorityValue(task.priority)).padStart(2, '0')}:${task.dueDate ?? '9999-12-31'}:${task.id}`;
}

function priorityValue(priority: string | null | undefined): number {
  return priorityRank[priority?.trim().toLowerCase() ?? ''] ?? 5;
}

function secondsToHours(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value <= 0) return null;
  return Math.round((value / 3_600) * 100) / 100;
}

function parseBusinessDate(value: string, field: string): { value: string; time: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) invalidDate(field);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  // 业务日期的边界是 Asia/Shanghai 零点，不能直接拿 UTC 零点筛选周一凌晨的数据。
  const time = Date.UTC(year, month - 1, day) - shanghaiOffsetMilliseconds;
  const date = new Date(time + shanghaiOffsetMilliseconds);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalidDate(field);
  }
  return { value, time };
}

function parseBusinessTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalidDate(field);
  return timestamp;
}

function invalidDate(field: string): never {
  throw new DomainError('WEEKLY_REPORT_DATE_INVALID', `${field} 不是有效日期`, { httpStatus: 422 });
}

function addDays(timestamp: number, days: number): number {
  return timestamp + days * 86_400_000;
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new DomainError('WEEKLY_REPORT_SOURCE_DUPLICATE', `${label}来源 ID 不能重复`, {
      httpStatus: 422,
    });
  }
}
