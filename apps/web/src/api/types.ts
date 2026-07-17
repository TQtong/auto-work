export interface Health {
  status: 'ready' | 'degraded';
  liveness: string;
  readiness: {
    database: { ready: boolean; quickCheck: string };
    scheduler: { ready: boolean; persistence: string };
    gitWorker: { ready: boolean; reason?: string };
  };
  binding: { host: string; port: number; loopbackOnly: boolean };
  environment: string;
}

export interface IdentityAlias {
  id: string;
  aliasType: string;
  value: string;
  source: string;
  enabled: boolean;
  verifiedAt: string | null;
}

export interface UserProfile {
  id: string;
  displayName: string;
  timezone: string;
  workdayHours: number;
  version: number;
  aliases: IdentityAlias[];
}

export interface Integration {
  id: string;
  type: 'gitlab' | 'jira' | 'dingtalk_log' | 'dingtalk_robot' | 'ai';
  name: string;
  baseUrl: string | null;
  credentialMask: Record<string, string> | null;
  enabled: boolean;
  status: string;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  version: number;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  cancelRequested: boolean;
  payloadSummary: Record<string, unknown>;
  lastErrorCode: string | null;
  lastError: string | null;
  scheduledAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AuditEvent {
  eventId: string;
  occurredAt: string;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: string;
  errorCode: string | null;
}

export interface Backup {
  id: string;
  fileName: string | null;
  sha256: string | null;
  sizeBytes: string | null;
  status: string;
  verifiedAt: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  alias: string | null;
  description: string | null;
  enabled: boolean;
  archivedAt: string | null;
  repositoryCount: number;
  version: number;
}

export interface RepositorySnapshot {
  id: string;
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
  recentCommit: Record<string, string>;
  remotes: Array<{
    name: string;
    sanitizedUrl: string | null;
    protocol: string | null;
    host: string | null;
    path: string | null;
  }>;
  status: string;
  errorCode: string | null;
  collectedAt: string;
}

export interface RepositoryView {
  id: string;
  project: { id: string; name: string; alias: string | null } | null;
  canonicalPath: string;
  displayName: string;
  alias: string | null;
  gitDirKind: string;
  remoteName: string | null;
  remoteUrl: string | null;
  remoteHost: string | null;
  remotePath: string | null;
  baselineBranch: string | null;
  whitelistStatus: string;
  statusReason: string | null;
  lastSeenAt: string | null;
  lastLocalRefreshAt: string | null;
  freshness: string;
  version: number;
  latestSnapshot: RepositorySnapshot | null;
}
