import type { TaskSummary } from '../api/types.js';

export interface TaskFilters {
  status?: string | undefined;
  rawStatus?: string | undefined;
  currentUser?: string | undefined;
  connectionId?: string | undefined;
  projectId?: string | undefined;
  parentIssueKey?: string | undefined;
  sprintId?: string | undefined;
  source?: string | undefined;
  evidenceState?: string | undefined;
  conflict?: string | undefined;
  visibility: string;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export function buildTaskQuery(
  filters: TaskFilters,
  pagination: { limit: number; cursor?: string | undefined },
): string {
  const parameters = new URLSearchParams({
    limit: String(pagination.limit),
    visibility: filters.visibility,
  });
  for (const [key, value] of Object.entries({ ...filters, cursor: pagination.cursor })) {
    if (value && key !== 'visibility') parameters.set(key, value);
  }
  return parameters.toString();
}

export function groupTasksByParent(tasks: TaskSummary[]) {
  const groups = new Map<
    string,
    { key: string; issueKey: string | null; title: string; tasks: TaskSummary[] }
  >();
  for (const task of tasks) {
    const sprintParentTitle = sprintParentTitleFromTask(task);
    const key = sprintParentTitle
      ? `sprint:${task.project?.id ?? task.projectKey ?? 'none'}:${sprintParentTitle}`
      : (task.parent.issueKey ?? `unparented:${task.project?.id ?? task.projectKey ?? 'none'}`);
    const group = groups.get(key) ?? {
      key,
      issueKey: sprintParentTitle ? null : task.parent.issueKey,
      title:
        sprintParentTitle ??
        task.parent.title ??
        (task.parent.issueKey ? '未返回父任务标题' : '无父任务'),
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.issueKey === null && right.issueKey !== null) return 1;
    if (left.issueKey !== null && right.issueKey === null) return -1;
    return (left.issueKey ?? left.title).localeCompare(right.issueKey ?? right.title, 'zh-CN');
  });
}

function sprintParentTitleFromTask(task: TaskSummary): string | null {
  for (const sprint of task.sprints ?? []) {
    const name = sprint.name ?? '';
    const match = /【([^】]+)】/u.exec(name);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}
