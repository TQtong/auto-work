import { describe, expect, it } from 'vitest';
import type { EvidenceLinkView } from '../api/types.js';
import { batchSelection, evidenceMethodLabel, isBatchConfirmable } from './evidence-view-model.js';

function link(
  id: string,
  method: EvidenceLinkView['method'],
  confidence: number,
  status: EvidenceLinkView['status'] = 'suggested',
): EvidenceLinkView {
  return {
    id,
    targetType: 'task',
    targetId: 'task-1',
    evidenceId: `evidence-${id}`,
    method,
    confidence,
    status,
    explanation: 'test',
    matchedValue: null,
    ruleVersion: 'v1',
    sourceContentHash: 'hash',
    decisionReason: null,
    confirmedBy: null,
    confirmedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    expiresAt: null,
    expiredAt: null,
    revalidationState: 'valid',
    version: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    evidence: {
      id: `evidence-${id}`,
      sourceType: 'commit',
      sourceExternalKey: id,
      eventAt: null,
      title: id,
      url: null,
      contentHash: 'hash',
      availabilityState: 'available',
      sourceSyncedAt: null,
      project: null,
      gitlabProject: null,
    },
    events: [],
  };
}

describe('证据页面批量门禁', () => {
  it('只允许同一高确定性规则，关键词和 AI 即使勾选也不能批量确认', () => {
    const links = [
      link('a', 'commit_issue_key', 0.98),
      link('b', 'commit_issue_key', 0.98),
      link('c', 'keyword', 0.79),
      link('d', 'ai', 0.79),
    ];
    expect(batchSelection(links, ['a', 'b'])).toMatchObject({
      enabled: true,
      method: 'commit_issue_key',
    });
    expect(batchSelection(links, ['a', 'c']).enabled).toBe(false);
    expect(isBatchConfirmable(links[3]!)).toBe(false);
  });

  it('不同确定性方法不能混批，需要复核的已确认关系仍可重新确认', () => {
    const commit = link('commit', 'commit_issue_key', 0.98);
    const branch = link('branch', 'branch_issue_key', 1);
    const revalidate = link('review', 'commit_issue_key', 0.98, 'confirmed');
    revalidate.revalidationState = 'needs_revalidation';
    expect(batchSelection([commit, branch], ['commit', 'branch']).enabled).toBe(false);
    expect(isBatchConfirmable(revalidate)).toBe(true);
    expect(evidenceMethodLabel('pipeline_confirmed_commit')).toContain('Pipeline');
  });
});
