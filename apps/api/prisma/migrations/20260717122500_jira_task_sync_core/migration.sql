PRAGMA foreign_keys=OFF;

CREATE TABLE "new_integration_connection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL CHECK ("type" IN ('gitlab', 'jira', 'dingtalk_log', 'dingtalk_robot', 'ai')),
  "name" TEXT NOT NULL,
  "base_url" TEXT,
  "credential_ref" TEXT,
  "credential_mask" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'unknown' CHECK ("status" IN ('unknown', 'testing', 'healthy', 'degraded', 'invalid', 'disabled', 'configuration_required', 'mapping_invalid')),
  "capabilities_json" TEXT NOT NULL DEFAULT '{}',
  "config_json" TEXT NOT NULL DEFAULT '{}',
  "last_tested_at" DATETIME,
  "last_success_at" DATETIME,
  "disabled_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

INSERT INTO "new_integration_connection" (
  "id", "type", "name", "base_url", "credential_ref", "credential_mask", "enabled", "status",
  "capabilities_json", "config_json", "last_tested_at", "last_success_at", "disabled_at", "version",
  "created_at", "updated_at"
) SELECT
  "id", "type", "name", "base_url", "credential_ref", "credential_mask", "enabled", "status",
  "capabilities_json", "config_json", "last_tested_at", "last_success_at", "disabled_at", "version",
  "created_at", "updated_at"
FROM "integration_connection";

DROP TABLE "integration_connection";
ALTER TABLE "new_integration_connection" RENAME TO "integration_connection";
CREATE INDEX "integration_connection_type_enabled_status_idx" ON "integration_connection"("type", "enabled", "status");

PRAGMA foreign_keys=ON;

ALTER TABLE "project" ADD COLUMN "jira_project_key" TEXT;

CREATE UNIQUE INDEX "project_jira_project_key_key" ON "project"("jira_project_key");

CREATE TABLE "task" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connection_id" TEXT,
  "project_id" TEXT,
  "primary_source" TEXT NOT NULL,
  "external_id" TEXT,
  "issue_key" TEXT,
  "project_key" TEXT,
  "issue_type" TEXT,
  "parent_task_id" TEXT,
  "parent_issue_key" TEXT,
  "parent_title" TEXT,
  "title" TEXT NOT NULL,
  "description_policy" TEXT NOT NULL DEFAULT 'not_persisted',
  "priority" TEXT,
  "assignee_external_id" TEXT,
  "assignee_name" TEXT,
  "is_current_user" BOOLEAN NOT NULL DEFAULT false,
  "raw_status_id" TEXT,
  "raw_status_name" TEXT,
  "normalized_status" TEXT NOT NULL DEFAULT 'other',
  "planned_start_date" TEXT,
  "due_date" TEXT,
  "original_estimate_seconds" INTEGER,
  "remaining_estimate_seconds" INTEGER,
  "time_spent_seconds" INTEGER,
  "sprint_ids_json" TEXT NOT NULL DEFAULT '[]',
  "labels_json" TEXT NOT NULL DEFAULT '[]',
  "components_json" TEXT NOT NULL DEFAULT '[]',
  "external_updated_at" DATETIME,
  "last_observed_at" DATETIME NOT NULL,
  "visibility_state" TEXT NOT NULL DEFAULT 'visible',
  "mapping_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "task_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_mapping_version_id_fkey" FOREIGN KEY ("mapping_version_id") REFERENCES "field_mapping_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_primary_source_check" CHECK ("primary_source" IN ('jira', 'excel', 'manual')),
  CONSTRAINT "task_normalized_status_check" CHECK ("normalized_status" IN ('planned', 'in_progress', 'done', 'blocked', 'cancelled', 'other')),
  CONSTRAINT "task_visibility_state_check" CHECK ("visibility_state" IN ('visible', 'out_of_scope', 'unavailable')),
  CONSTRAINT "task_estimate_nonnegative_check" CHECK (
    ("original_estimate_seconds" IS NULL OR "original_estimate_seconds" >= 0) AND
    ("remaining_estimate_seconds" IS NULL OR "remaining_estimate_seconds" >= 0) AND
    ("time_spent_seconds" IS NULL OR "time_spent_seconds" >= 0)
  )
);

CREATE UNIQUE INDEX "task_connection_id_issue_key_key" ON "task"("connection_id", "issue_key");
CREATE INDEX "task_project_id_normalized_status_due_date_idx" ON "task"("project_id", "normalized_status", "due_date");
CREATE INDEX "task_connection_id_visibility_state_external_updated_at_idx" ON "task"("connection_id", "visibility_state", "external_updated_at");
CREATE INDEX "task_parent_task_id_idx" ON "task"("parent_task_id");

CREATE TABLE "task_source_observation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_updated_at" DATETIME,
  "content_hash" TEXT NOT NULL,
  "fields_json" TEXT NOT NULL,
  "warnings_json" TEXT NOT NULL DEFAULT '[]',
  "sync_run_id" TEXT,
  "mapping_version_id" TEXT,
  "observed_at" DATETIME NOT NULL,
  CONSTRAINT "task_source_observation_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_source_observation_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "jira_sync_run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_source_observation_mapping_version_id_fkey" FOREIGN KEY ("mapping_version_id") REFERENCES "field_mapping_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_source_observation_task_id_source_updated_at_content_hash_key" ON "task_source_observation"("task_id", "source_updated_at", "content_hash");
CREATE INDEX "task_source_observation_sync_run_id_idx" ON "task_source_observation"("sync_run_id");
CREATE INDEX "task_source_observation_task_id_observed_at_idx" ON "task_source_observation"("task_id", "observed_at");

CREATE TABLE "task_status_event" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "from_raw_status_id" TEXT,
  "from_raw_status_name" TEXT,
  "from_normalized_status" TEXT,
  "to_raw_status_id" TEXT,
  "to_raw_status_name" TEXT,
  "to_normalized_status" TEXT NOT NULL,
  "effective_at" DATETIME,
  "observed_at" DATETIME NOT NULL,
  "observed_interval_start" DATETIME,
  "source_observation_id" TEXT NOT NULL,
  CONSTRAINT "task_status_event_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_status_event_source_observation_id_fkey" FOREIGN KEY ("source_observation_id") REFERENCES "task_source_observation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_status_event_normalized_status_check" CHECK ("to_normalized_status" IN ('planned', 'in_progress', 'done', 'blocked', 'cancelled', 'other'))
);

CREATE UNIQUE INDEX "task_status_event_task_id_source_observation_id_key" ON "task_status_event"("task_id", "source_observation_id");
CREATE INDEX "task_status_event_task_id_observed_at_idx" ON "task_status_event"("task_id", "observed_at");

CREATE TABLE "sync_cursor" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connection_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "last_updated_at" DATETIME,
  "last_tiebreaker" TEXT,
  "overlap_seconds" INTEGER NOT NULL DEFAULT 120,
  "last_success_run_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "sync_cursor_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sync_cursor_overlap_check" CHECK ("overlap_seconds" BETWEEN 0 AND 3600)
);

CREATE UNIQUE INDEX "sync_cursor_connection_id_scope_key" ON "sync_cursor"("connection_id", "scope");

CREATE TABLE "jira_sync_run" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connection_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "mapping_version_id" TEXT NOT NULL,
  "query_hash" TEXT NOT NULL,
  "request_json" TEXT NOT NULL DEFAULT '{}',
  "page_count" INTEGER NOT NULL DEFAULT 0,
  "read_count" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "updated_count" INTEGER NOT NULL DEFAULT 0,
  "unchanged_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "error_summary" TEXT,
  "cursor_before_json" TEXT NOT NULL DEFAULT '{}',
  "cursor_after_json" TEXT NOT NULL DEFAULT '{}',
  "started_at" DATETIME NOT NULL,
  "completed_at" DATETIME,
  CONSTRAINT "jira_sync_run_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "jira_sync_run_mapping_version_id_fkey" FOREIGN KEY ("mapping_version_id") REFERENCES "field_mapping_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "jira_sync_run_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX "jira_sync_run_connection_id_started_at_idx" ON "jira_sync_run"("connection_id", "started_at");
CREATE INDEX "jira_sync_run_status_started_at_idx" ON "jira_sync_run"("status", "started_at");
