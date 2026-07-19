import { describe, expect, it } from 'vitest';
import { buildJiraQuery } from '../src/lib/jira-query-policy.js';

describe('Jira 结构化 JQL 策略', () => {
  it('默认展示、增量、周报和季度范围使用不同且确定的排序语义', () => {
    expect(buildJiraQuery({ scope: 'default' })).toBe(
      'assignee = currentUser() ORDER BY updated DESC',
    );
    expect(
      buildJiraQuery({ scope: 'incremental', updatedFloor: new Date('2026-07-17T00:00:00Z') }),
    ).toBe(
      'assignee = currentUser() AND updated >= "2026-07-17T00:00:00.000Z" ORDER BY updated ASC, key ASC',
    );
    expect(
      buildJiraQuery({
        scope: 'weekly',
        periodStart: '2026-07-13',
        periodEnd: '2026-07-19',
        plannedStartFieldId: 'customfield_10010',
      }),
    ).toBe(
      'assignee = currentUser() AND ((updated >= "2026-07-13" AND updated <= "2026-07-19") OR (duedate >= "2026-07-13" AND duedate <= "2026-07-19") OR (customfield_10010 >= "2026-07-13" AND customfield_10010 <= "2026-07-19")) ORDER BY project ASC, updated ASC, key ASC',
    );
    expect(
      buildJiraQuery({ scope: 'quarterly', periodStart: '2026-07-01', periodEnd: '2026-10-01' }),
    ).toContain('updated < "2026-10-01"');
  });

  it('拒绝歧义或注入式日期，调用方无法拼接任意 JQL', () => {
    expect(() =>
      buildJiraQuery({
        scope: 'weekly',
        periodStart: '2026-07-01" OR assignee IS NOT EMPTY',
        periodEnd: '2026-07-07',
      }),
    ).toThrowError(expect.objectContaining({ code: 'JIRA_PERIOD_INVALID' }));
    expect(() =>
      buildJiraQuery({
        scope: 'weekly',
        periodStart: '2026-02-31',
        periodEnd: '2026-03-07',
      }),
    ).toThrowError(expect.objectContaining({ code: 'JIRA_PERIOD_INVALID' }));
    expect(() =>
      buildJiraQuery({
        scope: 'quarterly',
        periodStart: '2026-10-01',
        periodEnd: '2026-07-01',
      }),
    ).toThrowError(expect.objectContaining({ code: 'JIRA_PERIOD_INVALID' }));
    expect(() =>
      buildJiraQuery({
        scope: 'weekly',
        periodStart: '2026-07-13',
        periodEnd: '2026-07-19',
        plannedStartFieldId: 'customfield_1 OR assignee',
      }),
    ).toThrowError(expect.objectContaining({ code: 'JIRA_FIELD_ID_INVALID' }));
  });
});
