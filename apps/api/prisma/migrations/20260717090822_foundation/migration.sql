-- CreateTable
CREATE TABLE "schema_metadata" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1 CHECK ("id" = 1),
    "application_version" TEXT NOT NULL,
    "schema_checksum" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "instance_lease" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "acquired_at" DATETIME NOT NULL,
    "renewed_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "windows_sid" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "workday_hours" INTEGER NOT NULL DEFAULT 8 CHECK ("workday_hours" > 0 AND "workday_hours" <= 24),
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "identity_alias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profile_id" TEXT NOT NULL,
    "alias_type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "identity_alias_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL CHECK ("type" IN ('gitlab', 'jira', 'dingtalk_log', 'dingtalk_robot', 'ai')),
    "name" TEXT NOT NULL,
    "base_url" TEXT,
    "credential_ref" TEXT,
    "credential_mask" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'unknown' CHECK ("status" IN ('unknown', 'testing', 'healthy', 'degraded', 'invalid', 'disabled', 'configuration_required')),
    "capabilities_json" TEXT NOT NULL DEFAULT '{}',
    "config_json" TEXT NOT NULL DEFAULT '{}',
    "last_tested_at" DATETIME,
    "last_success_at" DATETIME,
    "disabled_at" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "field_mapping_version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connection_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL CHECK ("version_no" > 0),
    "effective_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "field_mappings_json" TEXT NOT NULL,
    "status_mappings_json" TEXT NOT NULL DEFAULT '{}',
    "parser_rules_json" TEXT NOT NULL DEFAULT '{}',
    "validation_summary_json" TEXT NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "field_mapping_version_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'processing' CHECK ("state" IN ('processing', 'completed', 'failed')),
    "http_status" INTEGER,
    "response_json" TEXT,
    "error_code" TEXT,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload_ref" TEXT,
    "payload_summary" TEXT NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 100 CHECK ("priority" >= 0),
    "status" TEXT NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'dead_letter')),
    "progress" INTEGER NOT NULL DEFAULT 0 CHECK ("progress" >= 0 AND "progress" <= 100),
    "scheduled_at" DATETIME NOT NULL,
    "lease_owner" TEXT,
    "lease_until" DATETIME,
    "attempt_count" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
    "max_attempts" INTEGER NOT NULL DEFAULT 3 CHECK ("max_attempts" > 0),
    "dedupe_key" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_error_code" TEXT,
    "last_error" TEXT,
    "result_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_event" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "approval_id" TEXT,
    "outcome" TEXT NOT NULL,
    "before_summary_hash" TEXT,
    "after_summary_hash" TEXT,
    "client_session_hash" TEXT NOT NULL,
    "error_code" TEXT
);

-- CreateTable
CREATE TABLE "app_event_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "correlation_id" TEXT,
    "operation_id" TEXT,
    "target_type" TEXT,
    "target_id" TEXT,
    "duration_ms" INTEGER CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
    "outcome" TEXT,
    "error_code" TEXT,
    "attributes_json" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "backup_artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "file_name" TEXT,
    "path" TEXT,
    "sha256" TEXT,
    "size_bytes" BIGINT CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0),
    "status" TEXT NOT NULL,
    "schema_checksum" TEXT,
    "verified_at" DATETIME,
    "error_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profile_windows_sid_key" ON "user_profile"("windows_sid");

-- CreateIndex
CREATE INDEX "identity_alias_profile_id_alias_type_enabled_idx" ON "identity_alias"("profile_id", "alias_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "identity_alias_profile_id_alias_type_normalized_value_key" ON "identity_alias"("profile_id", "alias_type", "normalized_value");

-- CreateIndex
CREATE INDEX "integration_connection_type_enabled_status_idx" ON "integration_connection"("type", "enabled", "status");

-- CreateIndex
CREATE UNIQUE INDEX "field_mapping_version_connection_id_version_no_key" ON "field_mapping_version"("connection_id", "version_no");

-- CreateIndex
CREATE INDEX "idempotency_record_expires_at_idx" ON "idempotency_record"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_actor_id_route_idempotency_key_key" ON "idempotency_record"("actor_id", "route", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_status_scheduled_at_priority_idx" ON "job"("status", "scheduled_at", "priority");

-- CreateIndex
CREATE INDEX "job_dedupe_key_status_idx" ON "job"("dedupe_key", "status");

-- 同一业务作业在排队或运行期间只能有一个活动实例，终态记录仍完整保留。
CREATE UNIQUE INDEX "job_active_dedupe_key_unique"
ON "job"("dedupe_key")
WHERE "dedupe_key" IS NOT NULL AND "status" IN ('queued', 'running');

-- CreateIndex
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_target_type_target_id_idx" ON "audit_event"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_event_correlation_id_idx" ON "audit_event"("correlation_id");

-- CreateIndex
CREATE INDEX "app_event_log_timestamp_idx" ON "app_event_log"("timestamp");

-- CreateIndex
CREATE INDEX "app_event_log_correlation_id_idx" ON "app_event_log"("correlation_id");

-- CreateIndex
CREATE INDEX "backup_artifact_created_at_idx" ON "backup_artifact"("created_at");
