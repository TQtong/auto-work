export const evidenceRuleVersion = 'evidence-rule-v1';
export const evidenceKeywordWindowDays = 45;

export type EvidenceSourceType =
  'branch' | 'commit' | 'merge_request' | 'pipeline' | 'tag' | 'release' | 'manual';

export type EvidenceMatchMethod =
  | 'branch_issue_key'
  | 'commit_issue_key'
  | 'mr_title_issue_key'
  | 'mr_branch_issue_key'
  | 'pipeline_confirmed_commit'
  | 'keyword'
  | 'ai'
  | 'manual';

export interface EvidenceMatchTask {
  id: string;
  issueKey: string | null;
  projectId: string | null;
  title: string;
  parentTitle?: string | null;
  anchorAt?: Date | null;
}

export interface EvidenceMatchSource {
  id: string;
  sourceType: EvidenceSourceType;
  gitlabProjectId?: string | null;
  projectId: string | null;
  eventAt: Date | null;
  title: string;
  contentHash: string;
  metadata?: {
    messageSummary?: string | null;
    sourceBranch?: string | null;
    ref?: string | null;
    sha?: string | null;
  };
}

export interface ConfirmedCommitRelation {
  taskId: string;
  sha: string;
  gitlabProjectId?: string | null;
}

export interface EvidenceSuggestion {
  taskId: string;
  evidenceId: string;
  method: EvidenceMatchMethod;
  confidence: number;
  matchedValue: string;
  explanation: string;
  ruleVersion: string;
}

export interface SuggestEvidenceLinksInput {
  tasks: EvidenceMatchTask[];
  evidence: EvidenceMatchSource[];
  knownProjectKeys: string[];
  confirmedCommitRelations?: ConfirmedCommitRelation[];
}

const methodRank: Record<EvidenceMatchMethod, number> = {
  manual: 100,
  branch_issue_key: 90,
  commit_issue_key: 85,
  mr_title_issue_key: 85,
  mr_branch_issue_key: 80,
  pipeline_confirmed_commit: 75,
  keyword: 50,
  ai: 40,
};

/** 排序只表达建议依据的确定性；人工关系单独置顶，AI 永远不会压过本地规则。 */
export function evidenceMethodRank(method: EvidenceMatchMethod): number {
  return methodRank[method];
}

/** 只识别配置中已知的 Jira 项目 key，并要求两侧边界，避免把普通编号误当任务。 */
export function extractKnownIssueKeys(text: string, knownProjectKeys: string[]): string[] {
  const keys = [
    ...new Set(
      knownProjectKeys
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^[A-Z][A-Z0-9_]*$/u.test(item)),
    ),
  ].sort((left, right) => right.length - left.length);
  if (keys.length === 0 || text.length === 0) return [];
  const alternatives = keys.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?:^|[^A-Z0-9_])((?:${alternatives})-[1-9][0-9]*)(?=$|[^A-Z0-9])`,
    'giu',
  );
  const matches = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    if (match[1]) matches.add(match[1].toUpperCase());
  }
  return [...matches];
}

export function suggestEvidenceLinks(input: SuggestEvidenceLinksInput): EvidenceSuggestion[] {
  const tasksByIssueKey = new Map(
    input.tasks
      .filter((task): task is EvidenceMatchTask & { issueKey: string } => Boolean(task.issueKey))
      .map((task) => [task.issueKey.toUpperCase(), task]),
  );
  const suggestions = new Map<string, EvidenceSuggestion>();

  for (const source of input.evidence) {
    for (const fact of deterministicFacts(source, input.knownProjectKeys)) {
      for (const issueKey of fact.issueKeys) {
        const task = tasksByIssueKey.get(issueKey);
        if (!task) continue;
        keepBest(suggestions, {
          taskId: task.id,
          evidenceId: source.id,
          method: fact.method,
          confidence: fact.confidence,
          matchedValue: issueKey,
          explanation: fact.explanation,
          ruleVersion: evidenceRuleVersion,
        });
      }
    }
  }

  // Pipeline 本身没有足够的任务语义，只能继承“同项目、同 SHA、已确认”的 Commit 关系。
  for (const source of input.evidence.filter((item) => item.sourceType === 'pipeline')) {
    const sha = source.metadata?.sha?.toLowerCase();
    if (!sha) continue;
    for (const relation of input.confirmedCommitRelations ?? []) {
      if (relation.sha.toLowerCase() !== sha) continue;
      if (
        relation.gitlabProjectId &&
        source.gitlabProjectId &&
        relation.gitlabProjectId !== source.gitlabProjectId
      ) {
        continue;
      }
      keepBest(suggestions, {
        taskId: relation.taskId,
        evidenceId: source.id,
        method: 'pipeline_confirmed_commit',
        confidence: 0.95,
        matchedValue: sha,
        explanation: 'Pipeline 与已确认任务 Commit 具有相同 SHA，继承该确认关系',
        ruleVersion: evidenceRuleVersion,
      });
    }
  }

  for (const source of input.evidence) {
    if (source.sourceType === 'pipeline') continue;
    for (const task of input.tasks) {
      const pairKey = suggestionKey(task.id, source.id);
      if (suggestions.has(pairKey)) continue;
      const confidence = keywordConfidence(task, source);
      if (confidence === null) continue;
      keepBest(suggestions, {
        taskId: task.id,
        evidenceId: source.id,
        method: 'keyword',
        confidence,
        matchedValue: task.title,
        explanation: '同项目、时间窗口内的标题关键词与任务内容重合，必须人工确认',
        ruleVersion: evidenceRuleVersion,
      });
    }
  }

  return [...suggestions.values()].sort(
    (left, right) =>
      evidenceMethodRank(right.method) - evidenceMethodRank(left.method) ||
      right.confidence - left.confidence ||
      left.taskId.localeCompare(right.taskId) ||
      left.evidenceId.localeCompare(right.evidenceId),
  );
}

function deterministicFacts(
  source: EvidenceMatchSource,
  knownProjectKeys: string[],
): Array<{
  method: EvidenceMatchMethod;
  confidence: number;
  issueKeys: string[];
  explanation: string;
}> {
  if (source.sourceType === 'branch') {
    return [
      {
        method: 'branch_issue_key',
        confidence: 1,
        issueKeys: extractKnownIssueKeys(source.title, knownProjectKeys),
        explanation: '分支名命中已知 Jira issue key',
      },
    ];
  }
  if (source.sourceType === 'commit') {
    return [
      {
        method: 'commit_issue_key',
        confidence: 0.98,
        issueKeys: extractKnownIssueKeys(
          `${source.title}\n${source.metadata?.messageSummary ?? ''}`,
          knownProjectKeys,
        ),
        explanation: 'Commit 标题或消息命中已知 Jira issue key',
      },
    ];
  }
  if (source.sourceType === 'merge_request') {
    return [
      {
        method: 'mr_title_issue_key',
        confidence: 0.98,
        issueKeys: extractKnownIssueKeys(source.title, knownProjectKeys),
        explanation: 'MR 标题命中已知 Jira issue key',
      },
      {
        method: 'mr_branch_issue_key',
        confidence: 0.95,
        issueKeys: extractKnownIssueKeys(source.metadata?.sourceBranch ?? '', knownProjectKeys),
        explanation: 'MR 来源分支命中已知 Jira issue key',
      },
    ];
  }
  return [];
}

function keywordConfidence(task: EvidenceMatchTask, source: EvidenceMatchSource): number | null {
  if (!task.projectId || !source.projectId || task.projectId !== source.projectId) return null;
  if (!task.anchorAt || !source.eventAt) return null;
  const distance = Math.abs(task.anchorAt.getTime() - source.eventAt.getTime());
  if (distance > evidenceKeywordWindowDays * 24 * 60 * 60 * 1_000) return null;

  const taskTitle = normalizeSearchText(task.title);
  const evidenceTitle = normalizeSearchText(source.title);
  if (taskTitle.length >= 4 && evidenceTitle.includes(taskTitle)) return 0.79;

  const taskTokens = significantTokens(`${task.title} ${task.parentTitle ?? ''}`);
  const evidenceTokens = new Set(significantTokens(source.title));
  const shared = taskTokens.filter((token) => evidenceTokens.has(token));
  if (shared.length < 2 && !shared.some((token) => token.length >= 4)) return null;
  const totalWeight = taskTokens.reduce((sum, token) => sum + token.length, 0);
  if (totalWeight === 0) return null;
  const sharedWeight = shared.reduce((sum, token) => sum + token.length, 0);
  return Math.min(0.79, Math.round((0.55 + (sharedWeight / totalWeight) * 0.24) * 100) / 100);
}

function significantTokens(value: string): string[] {
  const ignored = new Set(['feat', 'fix', 'chore', 'refactor', 'test', 'docs', 'merge', 'branch']);
  return [
    ...new Set(
      (normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (token) => token.length >= 2 && !/^\d+$/u.test(token) && !ignored.has(token),
      ),
    ),
  ];
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
}

function keepBest(target: Map<string, EvidenceSuggestion>, candidate: EvidenceSuggestion): void {
  const key = suggestionKey(candidate.taskId, candidate.evidenceId);
  const current = target.get(key);
  if (
    !current ||
    evidenceMethodRank(candidate.method) > evidenceMethodRank(current.method) ||
    (evidenceMethodRank(candidate.method) === evidenceMethodRank(current.method) &&
      candidate.confidence > current.confidence)
  ) {
    target.set(key, candidate);
  }
}

function suggestionKey(taskId: string, evidenceId: string): string {
  return `${taskId}:${evidenceId}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
