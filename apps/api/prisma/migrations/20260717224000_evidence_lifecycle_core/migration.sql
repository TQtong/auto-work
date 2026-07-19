CREATE TABLE "evidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source_type" TEXT NOT NULL,
  "source_internal_id" TEXT NOT NULL,
  "source_external_key" TEXT NOT NULL,
  "gitlab_project_id" TEXT,
  "project_id" TEXT,
  "event_at" DATETIME,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "content_hash" TEXT NOT NULL,
  "availability_state" TEXT NOT NULL DEFAULT 'available',
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "source_synced_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "evidence_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_source_type_check" CHECK ("source_type" IN ('branch', 'commit', 'merge_request', 'pipeline', 'tag', 'release', 'jira_observation', 'weekly_report', 'manual')),
  CONSTRAINT "evidence_availability_check" CHECK ("availability_state" IN ('available', 'stale', 'unavailable')),
  CONSTRAINT "evidence_version_check" CHECK ("version" > 0)
);

CREATE TABLE "evidence_link" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "task_id" TEXT,
  "evidence_id" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "confidence" REAL NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'suggested',
  "explanation" TEXT NOT NULL,
  "matched_value" TEXT,
  "rule_version" TEXT NOT NULL,
  "source_content_hash" TEXT NOT NULL,
  "decision_reason" TEXT,
  "confirmed_by" TEXT,
  "confirmed_at" DATETIME,
  "rejected_by" TEXT,
  "rejected_at" DATETIME,
  "expires_at" DATETIME,
  "expired_at" DATETIME,
  "revalidation_state" TEXT NOT NULL DEFAULT 'valid',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "evidence_link_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_link_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_link_target_type_check" CHECK ("target_type" IN ('task', 'achievement', 'report_segment')),
  CONSTRAINT "evidence_link_task_target_check" CHECK (("target_type" = 'task' AND "task_id" = "target_id") OR ("target_type" <> 'task' AND "task_id" IS NULL)),
  CONSTRAINT "evidence_link_method_check" CHECK ("method" IN ('branch_issue_key', 'commit_issue_key', 'mr_title_issue_key', 'mr_branch_issue_key', 'pipeline_confirmed_commit', 'keyword', 'ai', 'manual')),
  CONSTRAINT "evidence_link_confidence_check" CHECK ("confidence" >= 0.0 AND "confidence" <= 1.0),
  CONSTRAINT "evidence_link_status_check" CHECK ("status" IN ('suggested', 'confirmed', 'rejected', 'expired')),
  CONSTRAINT "evidence_link_revalidation_check" CHECK ("revalidation_state" IN ('valid', 'needs_revalidation')),
  CONSTRAINT "evidence_link_version_check" CHECK ("version" > 0)
);

CREATE TABLE "evidence_link_event" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "evidence_link_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "reason" TEXT,
  "source_content_hash" TEXT NOT NULL,
  "rule_version" TEXT NOT NULL,
  "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_link_event_link_id_fkey" FOREIGN KEY ("evidence_link_id") REFERENCES "evidence_link" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "evidence_link_event_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "evidence_link_event_status_check" CHECK ("to_status" IN ('suggested', 'confirmed', 'rejected', 'expired')),
  CONSTRAINT "evidence_link_event_actor_check" CHECK ("actor_type" IN ('local_user', 'scheduler', 'system'))
);

CREATE UNIQUE INDEX "evidence_source_type_source_internal_id_key" ON "evidence"("source_type", "source_internal_id");
CREATE INDEX "evidence_project_id_event_at_idx" ON "evidence"("project_id", "event_at");
CREATE INDEX "evidence_gitlab_project_id_source_type_availability_state_idx" ON "evidence"("gitlab_project_id", "source_type", "availability_state");
CREATE INDEX "evidence_availability_state_updated_at_idx" ON "evidence"("availability_state", "updated_at");

CREATE UNIQUE INDEX "evidence_link_target_type_target_id_evidence_id_key" ON "evidence_link"("target_type", "target_id", "evidence_id");
CREATE INDEX "evidence_link_task_id_status_confidence_idx" ON "evidence_link"("task_id", "status", "confidence");
CREATE INDEX "evidence_link_evidence_id_status_idx" ON "evidence_link"("evidence_id", "status");
CREATE INDEX "evidence_link_status_expires_at_idx" ON "evidence_link"("status", "expires_at");

CREATE UNIQUE INDEX "evidence_link_event_evidence_link_id_sequence_key" ON "evidence_link_event"("evidence_link_id", "sequence");
CREATE INDEX "evidence_link_event_occurred_at_idx" ON "evidence_link_event"("occurred_at");
