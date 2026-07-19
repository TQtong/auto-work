export const gitBatchActions = [
  'fetch_prune',
  'pull_ff_only',
  'create_branch',
  'checkout',
  'push_set_upstream',
  'push',
  'stash_create',
  'stash_apply',
  'stage_paths',
  'commit',
] as const;

export type GitBatchAction = (typeof gitBatchActions)[number];

export const gitItemResultCodes = [
  'succeeded',
  'already_satisfied',
  'skipped_by_user',
  'stale_preview',
  'blocked',
  'failed',
  'needs_review',
] as const;

export type GitItemResultCode = (typeof gitItemResultCodes)[number];

export interface GitBatchWarning {
  id: string;
  severity: 'information' | 'warning';
  message: string;
}

export interface GitBatchBlockReason {
  code: string;
  message: string;
  recovery: string;
}
