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
