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

export interface WeeklyReportReminderPolicy {
  id: string | null;
  version: number;
  enabled: boolean;
  robotConnectionId: string | null;
  timezone: 'Asia/Shanghai';
  workingWeekdays: number[];
  generation: WeeklyReportReminderClock;
  confirmation: WeeklyReportReminderClock;
  deadline: WeeklyReportReminderClock;
  graceMinutes: number;
  upcoming: Array<{
    cycleKey: string;
    reminderType: 'generation_reminder' | 'confirmation_reminder' | 'deadline_reminder';
    periodStart: string;
    periodEnd: string;
    reportDate: string;
    scheduledFor: string;
    graceUntil: string;
  }>;
  recentOccurrences: WeeklyReportReminderOccurrence[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WeeklyReportReminderOccurrence {
  id: string;
  policyVersion: number;
  reminderType: 'generation_reminder' | 'confirmation_reminder' | 'deadline_reminder';
  cycleKey: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  scheduledFor: string;
  graceUntil: string;
  status: 'planned' | 'queued' | 'succeeded' | 'failed' | 'unknown' | 'skipped' | 'cancelled';
  reportId: string | null;
  notificationId: string | null;
  jobId: string | null;
  queuedAt: string | null;
  skippedAt: string | null;
  skipReason: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  version: number;
}

export interface WeeklyReportReminderClock {
  enabled: boolean;
  weekday: number;
  time: string;
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
  credentialReplacementPending: boolean;
  pendingCredentialCreatedAt: string | null;
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

export interface DiagnosticFacts {
  generatedAt: string;
  runtime: {
    applicationVersion: string;
    schemaChecksum: string;
    nodeVersion: string;
    platform: string;
    architecture: string;
    uptimeSeconds: number;
    environment: string;
    binding: { host: string; port: number; loopbackOnly: boolean };
  };
  database: {
    journalMode: string;
    pageCount: number;
    pageSizeBytes: number;
    freePageCount: number;
    databaseLocationHash: string;
    readiness: { ready: boolean; quickCheck: string };
  };
  storage: {
    totalBytes: number;
    availableBytes: number;
    databaseBytes: number;
    categories: Record<string, number>;
    dataDirectoryHash: string;
  };
  jobs: Record<string, number>;
  integrations: Array<{ type: string; status: string; count: number }>;
  backups: {
    totalRecorded: number;
    latestStatus: string | null;
    latestCreatedAt: string | null;
    latestVerifiedAt: string | null;
    verificationAgeHours: number | null;
  };
  audit: { immutableEventCount: number };
  recentErrors: Array<{
    timestamp: string;
    level: string;
    component: string;
    eventName: string;
    outcome: string | null;
    errorCode: string | null;
    durationMs: number | null;
  }>;
}

export interface DiagnosticBundlePreview {
  formatVersion: string;
  includedSections: string[];
  exclusions: string[];
}

export interface DiagnosticBundle {
  bundleId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
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
  counts: { sourceObservations: number; statusEvents: number; evidenceLinks: number } | null;
  evidence: {
    counts: { suggested: number; confirmed: number; rejected: number; expired: number };
    needsRevalidation: number;
    total: number;
    state: 'none' | 'suggested' | 'confirmed' | 'rejected' | 'expired' | 'needs_revalidation';
  };
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
  fieldProvenances: Array<{
    id: string;
    fieldName: string;
    sourceType: 'jira' | 'excel' | 'manual';
    decision: 'source_fact' | 'supplement' | 'keep_jira' | 'override' | 'superseded';
    value: unknown;
    reason: string | null;
    active: boolean;
    effectiveAt: string;
    supersededAt: string | null;
    sourceObservationId: string | null;
    excelImportRowId: string | null;
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

export type EvidenceLinkStatus = 'suggested' | 'confirmed' | 'rejected' | 'expired';
export type EvidenceAvailability = 'available' | 'stale' | 'unavailable';
export type EvidenceSourceType =
  'branch' | 'commit' | 'merge_request' | 'pipeline' | 'tag' | 'release' | 'manual';

export interface EvidenceFact {
  id: string;
  sourceType: EvidenceSourceType;
  sourceExternalKey: string;
  eventAt: string | null;
  title: string;
  url: string | null;
  contentHash: string;
  availabilityState: EvidenceAvailability;
  sourceSyncedAt: string | null;
  project: { id: string; name: string } | null;
  gitlabProject: { id: string; pathWithNamespace: string; webUrl: string } | null;
}

export interface EvidenceLinkView {
  id: string;
  targetType: string;
  targetId: string;
  evidenceId: string;
  method:
    | 'branch_issue_key'
    | 'commit_issue_key'
    | 'mr_title_issue_key'
    | 'mr_branch_issue_key'
    | 'pipeline_confirmed_commit'
    | 'keyword'
    | 'ai'
    | 'manual';
  confidence: number;
  status: EvidenceLinkStatus;
  explanation: string;
  matchedValue: string | null;
  ruleVersion: string;
  sourceContentHash: string;
  decisionReason: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  expiresAt: string | null;
  expiredAt: string | null;
  revalidationState: 'valid' | 'needs_revalidation';
  version: number;
  createdAt: string;
  updatedAt: string;
  evidence: EvidenceFact;
  events: Array<{
    id: string;
    sequence: number;
    action: string;
    fromStatus: string | null;
    toStatus: string;
    actorType: string;
    actorId: string;
    reason: string | null;
    sourceContentHash: string;
    ruleVersion: string;
    occurredAt: string;
  }>;
}

export interface TaskEvidenceView {
  taskId: string;
  counts: { suggested: number; confirmed: number; rejected: number; expired: number };
  items: EvidenceLinkView[];
}

export interface EvidenceCatalogView {
  items: Array<EvidenceFact & { linkCount: number; version: number }>;
  total: number;
  page: { cursor?: string; nextCursor?: string; hasMore: boolean; limit: number };
}

export type ExcelDiagnosticSeverity = 'blocking' | 'conflict' | 'warning' | 'info';

export interface ExcelDiagnostic {
  severity: ExcelDiagnosticSeverity;
  code: string;
  message: string;
  cell?: string;
  suggestedAction?: string;
}

export interface ExcelImportSummary {
  id: string;
  fileName: string;
  fileSha256: string;
  fileSizeBytes: number;
  parserVersion: string;
  dateSystem: string;
  workdayHours: number;
  status: 'preview_ready' | 'committed' | 'failed';
  sheetSummaries: Array<{
    name: string;
    normalizedName: string;
    matchedBy: 'exact_name' | 'header';
    rowCount: number;
    taskRowCount: number;
    containerRowCount: number;
    ignoredColumns: Array<{ column: number; header: string | null }>;
    diagnostics: ExcelDiagnostic[];
  }>;
  ignoredColumns: Array<{ sheetName: string; column: number; header: string | null }>;
  diagnostics: ExcelDiagnostic[];
  counts: {
    blocking: number;
    conflict: number;
    warning: number;
    info: number;
    tasks: number;
    containers: number;
  };
  errorCode: string | null;
  errorSummary: string | null;
  committedAt: string | null;
  commitSummary: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExcelRawCell {
  address: string;
  type: string;
  value: unknown;
  formula: string | null;
  cachedResult: unknown;
  numberFormat: string | null;
}

export interface ExcelNormalizedRow {
  parentIssueKey: string | null;
  parentTitle: string | null;
  title: string | null;
  assigneeName: string | null;
  plannedStartDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  personDays: number | null;
  personDaysSource: 'empty' | 'formula_cache' | 'provided' | 'derived';
  isCurrentUser: boolean;
}

export interface ExcelImportRow {
  id: string;
  sheetName: string;
  rowNumber: number;
  rowKind: 'task' | 'container';
  fingerprint: string;
  raw: Record<string, ExcelRawCell | null>;
  normalized: ExcelNormalizedRow;
  diagnostics: ExcelDiagnostic[];
  candidates: Array<{
    id: string;
    issueKey: string | null;
    title: string;
    assigneeName: string | null;
    jiraValues: {
      plannedStartDate: string | null;
      dueDate: string | null;
      estimateHours: number | null;
    };
  }>;
  resolution: Record<string, unknown>;
  proposedAction: 'create_excel' | 'link_jira' | 'skip' | 'conflict' | 'blocked';
  commitStatus: 'pending' | 'committed' | 'skipped';
  matchedTask: { id: string; issueKey: string | null; title: string; primarySource: string } | null;
  committedTaskId: string | null;
  version: number;
}

export interface ExcelImportDetail extends ExcelImportSummary {
  rows: ExcelImportRow[];
}

export interface ExcelCommitResult {
  importId: string;
  status: 'committed';
  committedAt: string;
  previewVersion: number;
  summary: {
    created: number;
    linked: number;
    supplemented: number;
    keptJira: number;
    skipped: number;
  };
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

export type WeeklyReportStatus = 'collecting' | 'generated' | 'editing' | 'confirmed';

export interface WeeklyReportVersionSummary {
  id: string;
  versionNo: number;
  origin: 'rule' | 'ai' | 'manual' | 'restore';
  aiGenerationId?: string | null;
  parentVersionId?: string | null;
  sourceSnapshotId?: string;
  contentHash: string;
  templateMappingVersionId?: string | null;
  scheduleAt?: string | null;
  changeSummary?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

export interface WeeklyReportConfirmation {
  id: string;
  versionId: string;
  reportAggregateVersion: number;
  contentHash: string;
  templateMappingVersionId: string;
  warningAcknowledgements: Array<{ id: string; code: string; acknowledgedAt: string }>;
  recipientScopeHash: string;
  attachmentsHash: string;
  status: 'active' | 'invalidated';
  confirmedBy: string;
  confirmedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface WeeklyReport {
  id: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  timezone: 'Asia/Shanghai';
  templateName: string;
  templateMappingVersionId: string | null;
  status: WeeklyReportStatus;
  logDeliveryState: string;
  robotDeliveryState: string;
  currentVersionId: string | null;
  confirmedVersionId: string | null;
  currentVersion: WeeklyReportVersionSummary | null;
  confirmedVersion?: WeeklyReportVersionSummary | null;
  currentConfirmation?: WeeklyReportConfirmation | null;
  recipientScopeVersion: number;
  scheduleAt: string | null;
  versionCount: number | null;
  sourceSnapshotCount?: number;
  confirmationCount?: number;
  attachmentCount?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  delivery?: { log: string; robot: string; partial: boolean };
}

export interface WeeklyReportList {
  items: WeeklyReport[];
  total: number;
  page: { cursor?: string; nextCursor?: string; hasMore: boolean; limit: number };
}

export interface WeeklyReportDeliveryAttempt {
  id: string;
  attemptNo: number;
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  providerRequestId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  providerErrorCode: string | null;
  retryAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface WeeklyReportDeliveryRecoveryCheck {
  id: string;
  sequenceNo: number;
  mode: 'provider_query' | 'manual_resolution';
  outcome:
    | 'matched'
    | 'not_found'
    | 'absence_confirmed'
    | 'ambiguous'
    | 'query_failed'
    | 'manual_succeeded'
    | 'manual_absence_confirmed';
  queryWindowStart: string | null;
  queryWindowEnd: string | null;
  candidateCount: number;
  exactMatchCount: number;
  matchedExternalId: string | null;
  evidenceHash: string;
  actorId: string;
  createdAt: string;
  summary: Record<string, unknown>;
}

export interface WeeklyReportDeliveryIntent {
  id: string;
  reportId: string;
  confirmationId: string;
  confirmedVersionId: string;
  connectionId: string;
  channel: 'dingtalk_log' | 'dingtalk_robot';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'needs_review' | 'cancelled';
  scheduledFor: string;
  scheduleApprovedAt: string | null;
  scheduleApprovalHash: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  version: number;
  jobId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  recoveryStatus:
    | 'not_required'
    | 'pending'
    | 'not_found'
    | 'absence_confirmed'
    | 'matched'
    | 'ambiguous'
    | 'manual_succeeded'
    | 'manual_absence_confirmed';
  lastRecoveryAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: WeeklyReportDeliveryAttempt[];
  recoveryChecks: WeeklyReportDeliveryRecoveryCheck[];
}

export interface WeeklyReportRobotNotification {
  id: string;
  reportId: string | null;
  connectionId: string;
  deliveryIntentId: string | null;
  notificationType:
    | 'generation_reminder'
    | 'confirmation_reminder'
    | 'deadline_reminder'
    | 'submission_success'
    | 'submission_failure'
    | 'risk_alert';
  stateVersion: number;
  status:
    'pending' | 'queued' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'skipped' | 'cancelled';
  coalescedCount: number;
  scheduledFor: string;
  quietWindowStartedAt: string;
  quietWindowEndsAt: string;
  providerRequestId: string | null;
  providerCallCount: number;
  retryDelaysMs: number[];
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  sentAt: string | null;
  skippedAt: string | null;
  skipReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReportWarning {
  id: string;
  code: string;
  message?: string;
  blocking: boolean;
  sourceRefs?: Array<{ type: string; id: string }>;
  [key: string]: unknown;
}

export interface WeeklyReportAttachmentFact {
  id: string;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
}

export interface WeeklyReportAttachment extends WeeklyReportAttachmentFact {
  status: 'available' | 'deleted';
  createdAt: string;
  deletedAt: string | null;
}

export interface WeeklyReportRecipientFact {
  validationId: string;
  subjectType: 'user' | 'department' | 'group';
  externalId: string;
  displayName: string;
  observedAt: string;
  expiresAt: string;
  contentHash: string;
}

export interface WeeklyReportSourceSnapshot {
  id: string;
  periodStart: string;
  periodEnd: string;
  reportDate: string;
  timezone: string;
  calendarVersionId: string | null;
  profile: { id: string; version: number };
  jiraQuery: Record<string, unknown>;
  jiraSyncRunIds: string[];
  sources: {
    tasks: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
    manualInputs: Array<Record<string, unknown>>;
  };
  freshnessPolicy: Record<string, unknown>;
  warnings: unknown[];
  ruleVersion: string;
  templateMappingVersionId: string | null;
  sanitizationPolicyVersion: string;
  generationHash: string;
  sourceContentHash: string;
  createdAt: string;
}

export interface WeeklyReportVersion extends WeeklyReportVersionSummary {
  reportId: string;
  parentVersionId: string | null;
  fields: {
    reportDate: string;
    recentGoals: string;
    weeklyWork: string;
    nextWeekPlans: string;
    problems: string;
    other: string;
  };
  structuredFields: Record<string, unknown>;
  warnings: WeeklyReportWarning[];
  attachments: WeeklyReportAttachmentFact[];
  recipientScope: {
    connectionId?: string | null;
    recipients?: WeeklyReportRecipientFact[];
  };
  templateMappingVersionId: string | null;
  scheduleAt: string | null;
  sourceSnapshot: WeeklyReportSourceSnapshot;
  sourceLinks: Array<{
    id: string;
    field: string;
    blockId: string;
    sourceType: string;
    sourceId: string;
    sourceContentHash: string;
    sourceSummary: Record<string, unknown>;
  }>;
  changeSummary: Record<string, unknown>;
  createdBy: string;
}

export interface WeeklyReportExportCopy {
  reportId: string;
  versionId: string;
  versionNo: number;
  reportVersion: number;
  contentHash: string;
  periodStart: string;
  periodEnd: string;
  templateName: string;
  templateMappingVersionId: string | null;
  mappingSource: 'frozen_mapping' | 'canonical_fallback';
  submitted: false;
  formalLogState: string;
  generatedAt: string;
  warnings: string[];
  fields: Array<{
    internalField: keyof WeeklyReportVersion['fields'];
    label: string;
    order: number;
    content: string;
  }>;
  copyText: string;
  attachment: {
    fileName: string;
    mimeType: 'text/plain;charset=utf-8';
    encoding: 'base64';
    contentBase64: string;
    sizeBytes: number;
    sha256: string;
  };
}

export interface WeeklyAiGeneration {
  id: string;
  reportId: string;
  baseVersionId: string;
  baseReportVersion: number;
  providerConnectionId: string;
  providerConfigVersion: number;
  purpose: 'weekly_report';
  promptTemplateVersion: string;
  sanitizationPolicyVersion: string;
  retentionMode: 'hash_only' | 'sanitized_input';
  requestedFields: Array<Exclude<keyof WeeklyReportVersion['fields'], 'reportDate'>>;
  inputCategories: string[];
  removedCategories: string[];
  sanitizedInputHash: string | null;
  protocol: 'openai_compatible' | 'anthropic' | 'gemini';
  model: string;
  providerRequestId: string | null;
  stopReason: string | null;
  usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  };
  durationMs: number | null;
  status: 'succeeded' | 'failed' | 'blocked';
  errorCode: string | null;
  securityBlocks: string[];
  adoptionStatus: 'pending' | 'adopted' | 'rejected' | 'not_applicable';
  adoptedVersionId: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  stale: boolean;
  suggestionVersions: WeeklyReportVersionSummary[];
  inputRefs?: Array<{
    refId: string;
    sourceType: 'base_field' | 'task' | 'evidence' | 'manual';
    sourceId: string;
    field: string | null;
    contentHash: string;
  }>;
  rawOutput?: string | null;
  parsedOutput?: {
    fields?: Array<{
      field: string;
      paragraphs: Array<{ projectName: string | null; text: string; citations: string[] }>;
    }>;
  } | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface WeeklyAiGenerationList {
  items: WeeklyAiGeneration[];
  total: number;
}

export interface WeeklyAiSuggestionResult {
  replayed: boolean;
  fallback: boolean;
  fallbackReasonCode?: string;
  fallbackVersion?: { id: string; reportId: string };
  generation: WeeklyAiGeneration;
  suggestionVersion?: WeeklyReportVersionSummary;
  report?: { id: string; currentVersionId: string; version: number };
}

export interface DingTalkTemplateFieldMapping {
  internalField: string;
  externalFieldId: string;
  externalFieldName: string;
  externalType: string;
  order: number;
  required: boolean;
  maxLength: number | null;
}

export interface DingTalkTemplateMappingVersion {
  id: string;
  connectionId: string;
  versionNo: number;
  templateId: string;
  templateName: string;
  externalTemplateVersion: string | null;
  templateHash: string;
  fields: DingTalkTemplateFieldMapping[];
  capabilitySnapshotHash: string;
  observedAt: string;
  expiresAt: string;
  expired: boolean;
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface DingTalkTemplateMappingHistory {
  connectionId: string;
  currentVersionId: string | null;
  aggregateVersion: number | null;
  versions: DingTalkTemplateMappingVersion[];
}

export interface DingTalkRecipientValidation {
  id: string;
  subjectType: 'user' | 'department' | 'group';
  externalId: string;
  displayName: string;
  available: boolean;
  expired: boolean;
  observedAt: string;
  expiresAt: string;
  contentHash: string;
}

export type QuarterlyFormulaType = 'weighted_average_100' | 'weighted_sum' | 'simple_sum';
export type QuarterlyRoundingRule =
  'none' | 'half_up_integer' | 'half_up_1_decimal' | 'floor_integer' | 'ceil_integer';

export interface QuarterlyMetric {
  id: string;
  code: string;
  name: string;
  definition: string;
  weight: number;
  minimum: number;
  maximum: number;
  step: number;
  required: boolean;
  evidenceRequirement: Record<string, unknown>;
  order: number;
  enabled: boolean;
}

export interface QuarterlyMetricTemplateVersion {
  id: string;
  versionNo: number;
  formulaType: QuarterlyFormulaType;
  roundingRule: QuarterlyRoundingRule;
  contentHash: string;
  metrics: QuarterlyMetric[];
}

export interface QuarterlyMetricTemplateListItem {
  id: string;
  name: string;
  version: number;
  currentVersion: QuarterlyMetricTemplateVersion | null;
}

export interface QuarterlyBoundMetricTemplate extends QuarterlyMetricTemplateVersion {
  name: string;
  versionId: string;
}

export interface QuarterlyScoreItem {
  id: string;
  metricId: string;
  aiSuggestedScore: number | null;
  aiSuggestedMinimum: number | null;
  aiSuggestedMaximum: number | null;
  aiReason: string | null;
  aiEvidenceGaps: string[];
  aiUncertainty: string | null;
  userScore: number | null;
  userReason: string | null;
  rawContribution: number | null;
  validationStatus: string;
  version: number;
}

export interface QuarterlyCompleteness extends Record<string, unknown> {
  sourceFreshness?: string;
  evidenceCoverage?: number;
  requiredMetricCoverage?: number;
  scoreReasonCoverage?: number;
  unresolvedConflictCount?: number;
  selectedWithoutEvidenceCount?: number;
  selectedWithoutMetricCount?: number;
  requiredMetricUncoveredCount?: number;
  duplicateEvidenceReferenceCount?: number;
}

export interface QuarterlyReviewSummary {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  nextPeriodStart: string;
  timezone: string;
  naturalQuarter: boolean;
  year: number | null;
  quarter: number | null;
  status: string;
  metricTemplateVersionId: string | null;
  currentNarrativeVersionId: string | null;
  currentConfirmationId: string | null;
  achievementCount: number;
  exportCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuarterlyReview extends QuarterlyReviewSummary {
  completeness: QuarterlyCompleteness;
  metricTemplate: QuarterlyBoundMetricTemplate | null;
  scores: QuarterlyScoreItem[];
}

export interface QuarterlyReviewList {
  items: QuarterlyReviewSummary[];
  total: number;
}

export type QuarterlyAchievementStatus = 'candidate' | 'selected' | 'excluded' | 'needs_evidence';

export interface QuarterlyAchievementEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  title: string;
  externalKey: string | null;
  url: string | null;
  eventAt: string | null;
  availabilityState: string;
  sourceContentHash: string;
  sourceSummary: Record<string, unknown>;
  contributionAngle: string;
  primaryEvidence: boolean;
  duplicateInReview: boolean;
}

export interface QuarterlyAchievementMetricLink {
  id: string;
  metricId: string;
  metricCode: string;
  metricName: string;
  contribution: string;
  version: number;
}

export interface QuarterlyAchievement {
  id: string;
  reviewId: string;
  project: { id: string; name: string } | null;
  sourceType: 'collected' | 'manual';
  sourceKey: string;
  title: string;
  situation: string;
  action: string;
  result: string;
  impact: string;
  contributionBoundary: string;
  periodStart: string;
  periodEnd: string;
  selectionStatus: QuarterlyAchievementStatus;
  exclusionReason: string | null;
  evidenceStatus: string;
  sortOrder: number;
  version: number;
  evidences: QuarterlyAchievementEvidence[];
  metricLinks: QuarterlyAchievementMetricLink[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface QuarterlyCollectionSnapshot {
  id: string;
  sequenceNo: number;
  sources: Record<string, boolean>;
  freshnessPolicy: Record<string, unknown>;
  warnings: unknown[];
  taskCount: number;
  evidenceCount: number;
  weeklyReportCount: number;
  sourceContentHash: string;
  generationHash: string;
  createdAt: string;
}

export interface QuarterlyNarrativeCoreAchievement {
  heading: string;
  body: string;
  achievementIds: string[];
  metricIds: string[];
  evidenceIds: string[];
}

export interface QuarterlyNarrativeContent {
  overallOverview: string;
  coreAchievements: QuarterlyNarrativeCoreAchievement[];
  collaborationAndGrowth: string;
  problemsAndImprovements: string;
  nextPeriodPlan: string;
}

export interface QuarterlyNarrativeVersion {
  id: string;
  reviewId: string;
  versionNo: number;
  origin: 'rule' | 'manual' | 'ai';
  parentVersionId: string | null;
  sourceSnapshotHash: string;
  aiGenerationId: string | null;
  contentHash: string;
  changeSummary: Record<string, unknown>;
  content?: QuarterlyNarrativeContent;
  createdBy: string;
  createdAt: string;
}

export interface QuarterlyAiGeneration {
  id: string;
  reviewId: string | null;
  baseReviewVersion: number | null;
  providerConnectionId: string;
  providerConfigVersion: number;
  purpose: 'score_suggestion' | 'quarterly_review';
  promptTemplateVersion: string;
  sanitizationPolicyVersion: string;
  retentionMode: string;
  requestedFields: string[];
  inputCategories: string[];
  removedCategories: string[];
  sanitizedInputHash: string | null;
  protocol: string;
  model: string;
  providerRequestId: string | null;
  stopReason: string | null;
  usage: Record<string, unknown>;
  durationMs: number | null;
  status: 'pending' | 'succeeded' | 'failed' | 'blocked';
  errorCode: string | null;
  securityBlocks: string[];
  adoptionStatus: 'pending' | 'adopted' | 'rejected' | 'not_applicable';
  decisionReason: string | null;
  decidedAt: string | null;
  stale: boolean;
  inputRefs?: unknown[];
  rawOutput?: string | null;
  parsedOutput?: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface QuarterlyAiGenerationList {
  items: QuarterlyAiGeneration[];
  total: number;
}

export interface QuarterlyConfirmationPreflight {
  confirmable: boolean;
  blockers: Array<{ code: string; message: string }>;
  requiredAcknowledgements: Array<{ code: string; message: string; count: number }>;
  completeness: QuarterlyCompleteness;
}

export interface QuarterlyPerformanceCalculation {
  formulaType: QuarterlyFormulaType;
  roundingRule: QuarterlyRoundingRule;
  rawTotal: number;
  finalTotal: number;
  scoreCount: number;
  metricCount: number;
  items?: Array<Record<string, unknown>>;
}

export interface QuarterlyReviewConfirmation {
  id: string;
  reviewId: string;
  reviewVersion: number;
  metricTemplateVersionId: string;
  narrativeVersionId: string;
  snapshotHash: string;
  achievementsHash: string;
  scoresHash: string;
  calculation: QuarterlyPerformanceCalculation;
  acknowledgements: Array<Record<string, unknown>>;
  status: 'active' | 'invalidated';
  confirmedBy: string;
  confirmedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  reviewSnapshot?: Record<string, unknown>;
  achievementsSnapshot?: unknown[];
  scoresSnapshot?: unknown[];
  templateSnapshot?: Record<string, unknown>;
  narrativeSnapshot?: Record<string, unknown>;
  completenessSnapshot?: QuarterlyCompleteness;
}

export interface QuarterlyExportArtifact {
  id: string;
  reviewId: string;
  confirmationId: string;
  format: 'xlsx' | 'docx';
  templateVersion: string;
  inputSnapshotHash: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attemptCount: number;
  version: number;
  jobId: string | null;
  fileName: string | null;
  mimeType: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
  qaStatus: 'pending' | 'passed' | 'failed';
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  qaReport?: Record<string, unknown>;
  rendererFacts?: Record<string, unknown>;
}
