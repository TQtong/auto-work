import { describe, expect, it } from 'vitest';
import {
  evidenceMethodRank,
  extractKnownIssueKeys,
  suggestEvidenceLinks,
  type EvidenceMatchSource,
  type EvidenceMatchTask,
} from '../src/index.js';

const tasks: EvidenceMatchTask[] = [
  {
    id: 'task-100',
    issueKey: 'PROJ-100',
    projectId: 'project-1',
    title: '实现 Excel 导入向导',
    parentTitle: '研发工作台',
    anchorAt: new Date('2026-07-17T00:00:00.000Z'),
  },
  {
    id: 'task-200',
    issueKey: 'PROJ-200',
    projectId: 'project-1',
    title: '证据生命周期',
    anchorAt: new Date('2026-07-17T00:00:00.000Z'),
  },
];

function evidence(
  value: Partial<EvidenceMatchSource> & Pick<EvidenceMatchSource, 'id' | 'sourceType' | 'title'>,
): EvidenceMatchSource {
  return {
    projectId: 'project-1',
    gitlabProjectId: 'gitlab-project-1',
    eventAt: new Date('2026-07-18T00:00:00.000Z'),
    contentHash: `hash-${value.id}`,
    ...value,
  };
}

describe('证据匹配领域规则', () => {
  it('只提取已知项目 key、尊重边界并保留多 key 一对多', () => {
    expect(
      extractKnownIssueKeys('feature/proj-100_and OTHER-9；PROJ-200，XPROJ-300', ['PROJ']),
    ).toEqual(['PROJ-100', 'PROJ-200']);
    expect(extractKnownIssueKeys('PROJ-0 PROJ-01 PROJ-1A PROJ_2', ['PROJ'])).toEqual([]);
  });

  it('按分支、Commit、MR 标题和 MR 分支使用各自确定性与优先级', () => {
    const result = suggestEvidenceLinks({
      tasks,
      knownProjectKeys: ['PROJ'],
      evidence: [
        evidence({ id: 'branch', sourceType: 'branch', title: 'feature/PROJ-100-PROJ-200' }),
        evidence({
          id: 'commit',
          sourceType: 'commit',
          title: 'feat: PROJ-100 完成导入',
          metadata: { messageSummary: '同时处理 PROJ-200' },
        }),
        evidence({
          id: 'mr',
          sourceType: 'merge_request',
          title: 'PROJ-100 导入向导',
          metadata: { sourceBranch: 'feature/PROJ-200-evidence' },
        }),
      ],
    });
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-100',
          evidenceId: 'branch',
          method: 'branch_issue_key',
          confidence: 1,
        }),
        expect.objectContaining({
          taskId: 'task-200',
          evidenceId: 'branch',
          method: 'branch_issue_key',
          confidence: 1,
        }),
        expect.objectContaining({
          taskId: 'task-100',
          evidenceId: 'commit',
          method: 'commit_issue_key',
          confidence: 0.98,
        }),
        expect.objectContaining({
          taskId: 'task-200',
          evidenceId: 'commit',
          method: 'commit_issue_key',
          confidence: 0.98,
        }),
        expect.objectContaining({
          taskId: 'task-100',
          evidenceId: 'mr',
          method: 'mr_title_issue_key',
          confidence: 0.98,
        }),
        expect.objectContaining({
          taskId: 'task-200',
          evidenceId: 'mr',
          method: 'mr_branch_issue_key',
          confidence: 0.95,
        }),
      ]),
    );
  });

  it('Pipeline 只继承同项目同 SHA 的已确认 Commit 关系', () => {
    const pipeline = evidence({
      id: 'pipeline',
      sourceType: 'pipeline',
      title: 'Pipeline #88',
      metadata: { sha: 'ABCDEF' },
    });
    expect(
      suggestEvidenceLinks({
        tasks,
        evidence: [pipeline],
        knownProjectKeys: ['PROJ'],
      }),
    ).toEqual([]);
    expect(
      suggestEvidenceLinks({
        tasks,
        evidence: [pipeline],
        knownProjectKeys: ['PROJ'],
        confirmedCommitRelations: [
          { taskId: 'task-100', sha: 'abcdef', gitlabProjectId: 'gitlab-project-1' },
          { taskId: 'task-200', sha: 'abcdef', gitlabProjectId: 'another-project' },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        taskId: 'task-100',
        evidenceId: 'pipeline',
        method: 'pipeline_confirmed_commit',
        confidence: 0.95,
      }),
    ]);
  });

  it('关键词必须同项目且在时间窗内，置信度永不超过 0.79', () => {
    const result = suggestEvidenceLinks({
      tasks,
      knownProjectKeys: ['PROJ'],
      evidence: [
        evidence({ id: 'keyword', sourceType: 'commit', title: '实现 Excel 导入向导的浏览器验收' }),
        evidence({
          id: 'other-project',
          sourceType: 'commit',
          title: '实现 Excel 导入向导',
          projectId: 'project-2',
        }),
        evidence({
          id: 'outside-window',
          sourceType: 'commit',
          title: '实现 Excel 导入向导',
          eventAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ],
    });
    expect(result).toEqual([
      expect.objectContaining({
        taskId: 'task-100',
        evidenceId: 'keyword',
        method: 'keyword',
        confidence: 0.79,
      }),
    ]);
  });

  it('人工、确定性、关键词与 AI 的排序权重不会被低置信来源反超', () => {
    expect(evidenceMethodRank('manual')).toBeGreaterThan(evidenceMethodRank('branch_issue_key'));
    expect(evidenceMethodRank('branch_issue_key')).toBeGreaterThan(evidenceMethodRank('keyword'));
    expect(evidenceMethodRank('keyword')).toBeGreaterThan(evidenceMethodRank('ai'));
  });
});
