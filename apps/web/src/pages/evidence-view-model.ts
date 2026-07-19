import type { EvidenceLinkView, TaskSummary } from '../api/types.js';

const deterministicMethods = new Set<EvidenceLinkView['method']>([
  'branch_issue_key',
  'commit_issue_key',
  'mr_title_issue_key',
  'mr_branch_issue_key',
  'pipeline_confirmed_commit',
]);

export function isBatchConfirmable(link: EvidenceLinkView): boolean {
  // 页面只做第一层预筛选；服务端仍会校验方法、置信度、状态和乐观锁版本。
  return (
    deterministicMethods.has(link.method) &&
    link.confidence >= 0.95 &&
    (link.status === 'suggested' ||
      (link.status === 'confirmed' && link.revalidationState === 'needs_revalidation'))
  );
}

export function batchSelection(
  links: EvidenceLinkView[],
  selectedIds: string[],
): { enabled: boolean; method: EvidenceLinkView['method'] | null; reason: string } {
  const selected = links.filter((link) => selectedIds.includes(link.id));
  if (selected.length === 0) return { enabled: false, method: null, reason: '请选择证据关系' };
  if (!selected.every(isBatchConfirmable)) {
    return { enabled: false, method: null, reason: '包含低置信或非确定性关系，必须逐条查看' };
  }
  const methods = new Set(selected.map((link) => link.method));
  if (methods.size !== 1) {
    return { enabled: false, method: null, reason: '批量确认必须使用同一种匹配规则' };
  }
  return {
    enabled: true,
    method: selected[0]?.method ?? null,
    reason: `将确认 ${selected.length} 条同规则高确定性关系`,
  };
}

export function evidenceMethodLabel(method: EvidenceLinkView['method']): string {
  return {
    branch_issue_key: '分支 issue key',
    commit_issue_key: 'Commit issue key',
    mr_title_issue_key: 'MR 标题 issue key',
    mr_branch_issue_key: 'MR 分支 issue key',
    pipeline_confirmed_commit: 'Pipeline 继承已确认 Commit',
    keyword: '关键词建议',
    ai: 'AI 建议',
    manual: '人工绑定',
  }[method];
}

export function evidenceStateLabel(state: TaskSummary['evidence']['state']): string {
  return {
    none: '无证据',
    suggested: '待确认',
    confirmed: '已有确认',
    rejected: '均已拒绝',
    expired: '均已失效',
    needs_revalidation: '需要复核',
  }[state];
}
