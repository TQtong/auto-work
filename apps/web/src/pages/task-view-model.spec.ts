import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../api/types.js';
import { buildTaskQuery, groupTasksByParent } from './task-view-model.js';

describe('任务中心筛选与父任务分组', () => {
  it('把完整筛选和不透明游标编码到查询参数', () => {
    const query = new URLSearchParams(
      buildTaskQuery(
        {
          status: 'in_progress',
          rawStatus: '研发处理中',
          currentUser: 'true',
          connectionId: 'connection-id',
          projectId: 'project-id',
          parentIssueKey: 'PROJ-1',
          sprintId: '研发冲刺 12',
          source: 'jira',
          evidenceState: 'confirmed',
          conflict: 'true',
          visibility: 'visible',
          dateFrom: '2026-07-01',
          dateTo: '2026-07-31',
        },
        { limit: 50, cursor: 'opaque-cursor' },
      ),
    );

    expect(Object.fromEntries(query)).toEqual({
      limit: '50',
      visibility: 'visible',
      status: 'in_progress',
      rawStatus: '研发处理中',
      currentUser: 'true',
      connectionId: 'connection-id',
      projectId: 'project-id',
      parentIssueKey: 'PROJ-1',
      sprintId: '研发冲刺 12',
      source: 'jira',
      evidenceState: 'confirmed',
      conflict: 'true',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      cursor: 'opaque-cursor',
    });
  });

  it('按父任务稳定分组，并把无父任务按项目隔离后置', () => {
    const task = (id: string, parent: TaskSummary['parent'], projectId: string): TaskSummary =>
      ({
        id,
        parent,
        project: { id: projectId, name: projectId, jiraProjectKey: null },
      }) as TaskSummary;
    const groups = groupTasksByParent([
      task('orphan-a', { issueKey: null, title: null }, 'project-a'),
      task('child-b', { issueKey: 'PROJ-2', title: '父任务二' }, 'project-a'),
      task('child-a', { issueKey: 'PROJ-1', title: '父任务一' }, 'project-a'),
      task('orphan-b', { issueKey: null, title: null }, 'project-b'),
    ]);

    expect(groups.map((group) => [group.issueKey, group.tasks.map((item) => item.id)])).toEqual([
      ['PROJ-1', ['child-a']],
      ['PROJ-2', ['child-b']],
      [null, ['orphan-a']],
      [null, ['orphan-b']],
    ]);
  });

  it('存在 Sprint 父级标记时优先按 Sprint 的【父级】分组', () => {
    const task = (id: string, parent: TaskSummary['parent']): TaskSummary =>
      ({
        id,
        parent,
        project: { id: 'project-a', name: 'project-a', jiraProjectKey: null },
        sprints: [{ id: 'sprint-1', name: 'P_uTwin_20260727_HQ_【空间联通交互升级】' }],
      }) as TaskSummary;

    const groups = groupTasksByParent([
      task('child-a', { issueKey: 'PROJ-1', title: '运营后台重制密码功能' }),
      task('child-b', { issueKey: 'PROJ-2', title: '右键菜单交互优化' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      issueKey: null,
      title: '空间联通交互升级',
      tasks: [{ id: 'child-a' }, { id: 'child-b' }],
    });
  });
});
