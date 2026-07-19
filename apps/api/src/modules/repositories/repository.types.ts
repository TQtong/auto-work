export interface RepositoryIdentity {
  canonicalPath: string;
  realPathHash: string;
  identityHash: string;
  displayName: string;
  gitDirKind: 'normal' | 'worktree';
  headSha: string | null;
  branchName: string | null;
  unborn: boolean;
  defaultRemote: NormalizedRemoteObservation | null;
  remotes: NormalizedRemoteObservation[];
}

export interface NormalizedRemoteObservation {
  name: string;
  sanitizedUrl: string | null;
  protocol: 'https' | 'ssh' | null;
  host: string | null;
  port: number | null;
  path: string | null;
}

export interface GitStatusSnapshot {
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
  stashCount: number;
  recentCommit: Record<string, string> | null;
  remotes: NormalizedRemoteObservation[];
}

export interface DiscoveryWarning {
  directory: string;
  code: string;
  message: string;
}
