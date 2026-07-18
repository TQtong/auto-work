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
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'needs_review';
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
