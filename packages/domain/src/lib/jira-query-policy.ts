import { DomainError } from '@auto-work/contracts';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface JiraQueryInput {
  scope: 'default' | 'weekly' | 'quarterly' | 'incremental' | 'full';
  periodStart?: string;
  periodEnd?: string;
  updatedFloor?: Date | null;
  plannedStartFieldId?: string | null;
}

/** 只从结构化范围生成 JQL，调用方不能把任意文本拼接进后台同步查询。 */
export function buildJiraQuery(input: JiraQueryInput): string {
  switch (input.scope) {
    case 'default':
      return 'assignee = currentUser() ORDER BY updated DESC';
    case 'weekly': {
      const { start, end } = assertPeriod(input.periodStart, input.periodEnd, '周报', true);
      const plannedStart = input.plannedStartFieldId
        ? ` OR (${assertFieldId(input.plannedStartFieldId)} >= "${start}" AND ${input.plannedStartFieldId} <= "${end}")`
        : '';
      return `assignee = currentUser() AND ((updated >= "${start}" AND updated <= "${end}") OR (duedate >= "${start}" AND duedate <= "${end}")${plannedStart}) ORDER BY project ASC, updated ASC, key ASC`;
    }
    case 'quarterly': {
      const { start, end } = assertPeriod(input.periodStart, input.periodEnd, '季度', false);
      return `assignee = currentUser() AND updated >= "${start}" AND updated < "${end}" ORDER BY project ASC, updated ASC, key ASC`;
    }
    case 'incremental': {
      const floor = input.updatedFloor ?? new Date(0);
      return `assignee = currentUser() AND updated >= "${jiraDateTime(floor)}" ORDER BY updated ASC, key ASC`;
    }
    case 'full':
      return 'assignee = currentUser() ORDER BY updated ASC, key ASC';
  }
}

function jiraDateTime(value: Date): string {
  // Jira JQL 接受 yyyy-MM-dd HH:mm；ISO 8601 的 T、毫秒和 Z 在部分 Server/DC 版本会被拒绝。
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function assertBusinessDate(value: string | undefined, label: string): string {
  const parsed = value && DATE_PATTERN.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  if (
    !value ||
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new DomainError('JIRA_PERIOD_INVALID', `${label}必须是有效的 YYYY-MM-DD`, {
      httpStatus: 422,
    });
  }
  return value;
}

function assertPeriod(
  periodStart: string | undefined,
  periodEnd: string | undefined,
  label: string,
  allowSameDay: boolean,
): { start: string; end: string } {
  const start = assertBusinessDate(periodStart, `${label}开始日期`);
  const end = assertBusinessDate(periodEnd, `${label}结束日期`);
  if (allowSameDay ? start > end : start >= end) {
    throw new DomainError('JIRA_PERIOD_INVALID', `${label}结束日期必须晚于开始日期`, {
      httpStatus: 422,
    });
  }
  return { start, end };
}

function assertFieldId(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(value)) {
    throw new DomainError('JIRA_FIELD_ID_INVALID', 'Jira 计划开始字段 ID 无效', {
      httpStatus: 422,
    });
  }
  return value;
}
