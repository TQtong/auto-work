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

/**
 * 仓库发现根目录的只读诊断信息。
 * 路径本身是启动时安全边界，接口不会提供运行时改写能力。
 */
export interface RepositoryDiscoveryConfiguration {
  deploymentMode: 'native' | 'docker';
  configuredRoot: string;
  hostRoot: string;
  configurationKey: 'AUTO_WORK_REPOSITORY_ROOT' | 'AUTO_WORK_REPOSITORY_PATH';
  changeRequiresRestart: boolean;
  accessible: boolean;
  status: 'ready' | 'unavailable' | 'empty' | 'no_git_candidates';
  statusMessage: string;
  scanDepth: 1;
  directoryCount: number;
  gitCandidateCount: number;
  skippedEntryCount: number;
  detectedAt: string;
}
