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
  jiraProjectKey: string | null;
  enabled: boolean;
  archivedAt: string | null;
  repositoryCount: number;
  taskCount: number;
  version: number;
}

export interface JiraCapabilityField {
  id: string;
  name: string;
  custom: boolean;
  schema: { type?: string | null; items?: string | null } | null;
  occurrenceRate: number;
  sampleValues: unknown[];
}

export interface JiraCapabilityStatus {
  id: string;
  name: string;
  categoryKey: string | null;
  categoryName: string | null;
}

export interface JiraCapabilities {
  status: string;
  capabilities: {
    authenticated?: boolean;
    identity?: { id: string; username?: string | null; name?: string | null };
    search?: { post: boolean; getFallback: boolean; selectedMethod: 'post' | 'get' };
    fields?: JiraCapabilityField[];
    projects?: Array<{ id: string; key: string; name: string; archived: boolean }>;
    statuses?: JiraCapabilityStatus[];
    sampleIssueCount?: number;
    sampleTotal?: number;
    descriptionPersisted?: boolean;
    readOnly?: boolean;
  };
  currentMapping: { id: string; versionNo: number; effectiveAt: string } | null;
  cursors: Array<{
    scope: string;
    lastUpdatedAt: string | null;
    lastTiebreaker: string | null;
    overlapSeconds: number;
    lastSuccessRunId: string | null;
  }>;
}

export interface JiraMappingVersion {
  id: string;
  connectionId: string;
  versionNo: number;
  fieldMappings: Record<string, string | null>;
  statusMappings: Record<string, string>;
  parserRules: Record<string, unknown>;
  validationSummary: Record<string, unknown>;
  effectiveAt: string;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  source: 'jira' | 'excel' | 'manual';
  issueKey: string | null;
  projectKey: string | null;
  project: { id: string; name: string; jiraProjectKey: string | null } | null;
  issueType: string | null;
  parent: { issueKey: string | null; title: string | null };
  title: string;
  priority: string | null;
  assigneeName: string | null;
  isCurrentUser: boolean;
  status: { rawId: string | null; rawName: string | null; normalized: string };
  schedule: { plannedStartDate: string | null; dueDate: string | null };
  worklog: {
    originalEstimateSeconds: number | null;
    remainingEstimateSeconds: number | null;
    timeSpentSeconds: number | null;
  };
  sprints: Array<{ id: string | null; name: string | null; raw?: string }>;
  labels: string[];
  components: string[];
  externalUpdatedAt: string | null;
  lastObservedAt: string;
  visibilityState: string;
  counts: { sourceObservations: number; statusEvents: number } | null;
  version: number;
}

export interface TaskDetail extends TaskSummary {
  descriptionPolicy: string;
  parentTask: { id: string; issueKey: string | null; title: string } | null;
  childTasks: Array<{
    id: string;
    issueKey: string | null;
    title: string;
    normalizedStatus: string;
  }>;
  mappingVersion: { id: string; versionNo: number } | null;
  observations: Array<{
    id: string;
    sourceType: string;
    sourceUpdatedAt: string | null;
    fields: Record<string, unknown>;
    warnings: Array<{ code: string; message: string }>;
    contentHash: string;
    observedAt: string;
  }>;
  statusEvents: Array<{
    id: string;
    from: { id: string | null; name: string | null; normalized: string | null };
    to: { id: string | null; name: string | null; normalized: string };
    effectiveAt: string | null;
    observedAt: string;
    observedIntervalStart: string | null;
    precision: 'observed_interval';
  }>;
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
    port: number | null;
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
  remotePort: number | null;
  remotePath: string | null;
  gitlabConnectionId: string | null;
  gitlabProjectRef: string | null;
  baselineBranch: string | null;
  whitelistStatus: string;
  statusReason: string | null;
  lastSeenAt: string | null;
  lastLocalRefreshAt: string | null;
  freshness: string;
  version: number;
  latestSnapshot: RepositorySnapshot | null;
  gitlabMatchStatus: 'matched' | 'mismatch' | 'candidate' | 'unavailable';
  gitlabCandidates: GitLabRepositorySummary[];
  gitlabSummary: GitLabRepositorySummary | null;
}

export interface GitLabRepositorySummary {
  id: string;
  externalId: string;
  connectionId: string;
  pathWithNamespace: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  openMergeRequestCount: number;
  currentBranchMergeRequests: Array<{
    iid: number;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    webUrl: string;
  }>;
  latestCommit: {
    sha: string;
    title: string;
    authorName: string;
    committedAt: string;
    webUrl: string | null;
  } | null;
  latestPipeline: {
    status: string;
    sha: string;
    ref: string | null;
    updatedAt: string | null;
    webUrl: string | null;
  } | null;
  syncStatus: 'unknown' | 'refreshing' | 'fresh' | 'stale' | 'error';
  syncError: string | null;
  syncedAt: string | null;
}

export interface GitLabProjectCache {
  id: string;
  externalId: string;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
  visibility: string;
  archived: boolean;
  syncStatus: 'unknown' | 'refreshing' | 'fresh' | 'stale' | 'error';
  syncError: string | null;
  lastActivityAt: string | null;
  syncedAt: string | null;
  counts: {
    branches: number;
    commits: number;
    mergeRequests: number;
    pipelines: number;
    tags: number;
    releases: number;
    members: number;
  };
  openMergeRequestCount: number;
  latestPipeline: GitLabRepositorySummary['latestPipeline'];
  latestCommit: GitLabRepositorySummary['latestCommit'];
}

export type GitBatchAction =
  | 'fetch_prune'
  | 'pull_ff_only'
  | 'create_branch'
  | 'checkout'
  | 'push_set_upstream'
  | 'push'
  | 'stash_create'
  | 'stash_apply'
  | 'stage_paths'
  | 'commit';

export interface GitBatchItem {
  id: string;
  repositoryId: string;
  repositoryName: string;
  repositoryAlias: string | null;
  status: string;
  previewSnapshot: {
    headSha?: string | null;
    branchName?: string | null;
    upstreamRef?: string | null;
    stagedCount?: number;
    unstagedCount?: number;
    untrackedCount?: number;
    conflictedCount?: number;
    alreadySatisfied?: boolean;
  };
  displayCommand: string | null;
  expectedChanges: string[];
  warnings: Array<{ id: string; severity: 'information' | 'warning'; message: string }>;
  blockingReasons: Array<{ code: string; message: string; recovery: string }>;
  riskLevel: 'information' | 'warning' | 'sensitive';
  executable: boolean;
  selected: boolean;
  resultCode: string | null;
  resultSummary: string | null;
  postHeadSha: string | null;
  outputSummary: string | null;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitBatch {
  id: string;
  action: GitBatchAction;
  parameters: Record<string, unknown>;
  status: string;
  version: number;
  previewHash: string | null;
  previewedAt: string | null;
  expiresAt: string | null;
  approvedAt: string | null;
  executionStartedAt: string | null;
  executionEndedAt: string | null;
  summary: Record<string, number>;
  cancelReason: string | null;
  createdAt: string;
  items: GitBatchItem[];
}

export interface GitBatchSummary {
  id: string;
  action: GitBatchAction;
  status: string;
  version: number;
  expiresAt: string | null;
  summary: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}
