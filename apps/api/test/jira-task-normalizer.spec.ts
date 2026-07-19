import { describe, expect, it } from 'vitest';
import {
  normalizeJiraIssue,
  type JiraFieldMappings,
} from '../src/modules/jira/jira-task-normalizer.js';

const mappings: JiraFieldMappings = {
  plannedStartDate: 'customfield_start',
  dueDate: 'duedate',
  sprint: 'customfield_sprint',
  parent: 'parent',
  originalEstimateSeconds: 'timeoriginalestimate',
  remainingEstimateSeconds: 'timeestimate',
  timeSpentSeconds: 'timespent',
  assignee: 'assignee',
  status: 'status',
  priority: 'priority',
  labels: 'labels',
  components: 'components',
};

function issue(fields: Record<string, unknown>) {
  return {
    id: '10001',
    key: 'PROJ-1',
    fields: {
      summary: '实现完整同步',
      updated: '2026-07-17T12:00:00.000+0800',
      project: { key: 'PROJ' },
      issuetype: { name: '任务' },
      status: { id: '3', name: '进行中' },
      assignee: { accountId: 'user-1', displayName: '当前用户' },
      priority: { name: 'High' },
      parent: { key: 'PROJ-9', fields: { summary: '父任务' } },
      customfield_start: '2026-07-16',
      duedate: '2026-07-20',
      timeoriginalestimate: 28_800,
      timeestimate: 14_400,
      timespent: 3_600,
      customfield_sprint: [{ id: 7, name: 'Sprint 7' }],
      labels: ['backend'],
      components: [{ name: '同步' }],
      ...fields,
    },
  };
}

describe('Jira 任务规范化', () => {
  it('保留原始状态并按版本化映射生成统一状态与完整字段摘要', () => {
    const value = normalizeJiraIssue({
      issue: issue({}),
      mappings,
      statusMappings: { '3': 'in_progress' },
      currentIdentity: { id: 'user-1', name: '当前用户' },
    });

    expect(value).toMatchObject({
      issueKey: 'PROJ-1',
      projectKey: 'PROJ',
      parentIssueKey: 'PROJ-9',
      rawStatusId: '3',
      rawStatusName: '进行中',
      normalizedStatus: 'in_progress',
      isCurrentUser: true,
      plannedStartDate: '2026-07-16',
      dueDate: '2026-07-20',
      originalEstimateSeconds: 28_800,
      sprintIds: [{ id: '7', name: 'Sprint 7' }],
      labels: ['backend'],
      components: ['同步'],
    });
    expect(value.observationFields).not.toHaveProperty('description');
    expect(value.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('未知状态归入 other 但不丢失 raw 值，供应商 Sprint 字符串保留原文', () => {
    const sprint = 'com.atlassian.greenhopper.service.sprint.Sprint@abc[id=9,name=Sprint 九]';
    const value = normalizeJiraIssue({
      issue: issue({ status: { id: '99', name: '待业务确认' }, customfield_sprint: sprint }),
      mappings,
      statusMappings: { '3': 'in_progress' },
      currentIdentity: { id: 'another-user' },
    });

    expect(value.normalizedStatus).toBe('other');
    expect(value.rawStatusName).toBe('待业务确认');
    expect(value.sprintIds).toEqual([{ id: '9', name: 'Sprint 九', raw: sprint }]);
    expect(value.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'JIRA_STATUS_UNMAPPED' })]),
    );
  });

  it('映射字段类型漂移时阻断而不是把错误工时静默写成空值', () => {
    expect(() =>
      normalizeJiraIssue({
        issue: issue({ timeoriginalestimate: '八小时' }),
        mappings,
        statusMappings: { '3': 'in_progress' },
        currentIdentity: { id: 'user-1' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'JIRA_MAPPING_INVALID' }));
  });
});
