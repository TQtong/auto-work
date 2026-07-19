import type { GitBatchBlockReason, GitBatchWarning, GitItemResultCode } from '@auto-work/contracts';

export interface GitOperationSnapshot {
  repositoryIdentityHash: string;
  headSha: string | null;
  branchName: string | null;
  detached: boolean;
  unborn: boolean;
  upstreamRef: string | null;
  aheadCount: number;
  behindCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  pathSummary: Array<{ path: string; previousPath?: string; state: string }>;
  indexTree: string | null;
  actionFacts: Record<string, unknown>;
}

export interface GitItemPreview {
  snapshot: GitOperationSnapshot;
  snapshotHash: string;
  displayCommand: string;
  expectedChanges: string[];
  warnings: GitBatchWarning[];
  blockingReasons: GitBatchBlockReason[];
  riskLevel: 'information' | 'warning' | 'sensitive';
  executable: boolean;
  alreadySatisfied: boolean;
}

export interface GitExecutionResult {
  resultCode: GitItemResultCode;
  summary: string;
  exitCode: number | null;
  postHeadSha: string | null;
  outputSummary: string;
  durationMs: number;
}
