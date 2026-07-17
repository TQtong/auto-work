export const normalizedTaskStatuses = [
  'planned',
  'in_progress',
  'done',
  'blocked',
  'cancelled',
  'other',
] as const;

export type NormalizedTaskStatus = (typeof normalizedTaskStatuses)[number];

export const jiraFieldPurposes = [
  'plannedStartDate',
  'dueDate',
  'sprint',
  'parent',
  'originalEstimateSeconds',
  'remainingEstimateSeconds',
  'timeSpentSeconds',
  'assignee',
  'status',
  'priority',
  'labels',
  'components',
] as const;

export type JiraFieldPurpose = (typeof jiraFieldPurposes)[number];

export type JiraSyncScope = 'default' | 'weekly' | 'quarterly' | 'incremental' | 'full';
