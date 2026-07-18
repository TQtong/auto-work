-- CreateTable
CREATE TABLE "ai_generation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_profile_id" TEXT NOT NULL,
    "provider_connection_id" TEXT NOT NULL,
    "provider_config_version" INTEGER NOT NULL,
    "report_id" TEXT,
    "base_version_id" TEXT,
    "base_report_version" INTEGER,
    "adopted_version_id" TEXT,
    "purpose" TEXT NOT NULL,
    "prompt_template_version" TEXT NOT NULL,
    "sanitization_policy_version" TEXT NOT NULL,
    "retention_mode" TEXT NOT NULL DEFAULT 'hash_only',
    "requested_fields_json" TEXT NOT NULL DEFAULT '[]',
    "input_refs_json" TEXT NOT NULL DEFAULT '[]',
    "input_categories_json" TEXT NOT NULL DEFAULT '[]',
    "removed_categories_json" TEXT NOT NULL DEFAULT '[]',
    "sanitized_input_hash" TEXT,
    "sanitized_input_json" TEXT,
    "raw_output" TEXT,
    "parsed_output_json" TEXT,
    "protocol" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "stop_reason" TEXT,
    "usage_json" TEXT NOT NULL DEFAULT '{}',
    "duration_ms" INTEGER,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "security_blocks_json" TEXT NOT NULL DEFAULT '[]',
    "adoption_status" TEXT NOT NULL DEFAULT 'not_applicable',
    "decision_reason" TEXT,
    "decided_at" DATETIME,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "ai_generation_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ai_generation_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ai_generation_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ai_generation_base_version_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ai_generation_adopted_version_id_fkey" FOREIGN KEY ("adopted_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_weekly_report_version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "report_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "parent_version_id" TEXT,
    "report_date_text" TEXT NOT NULL,
    "recent_goals_text" TEXT NOT NULL,
    "weekly_work_text" TEXT NOT NULL,
    "next_week_plans_text" TEXT NOT NULL,
    "problems_text" TEXT NOT NULL,
    "other_text" TEXT NOT NULL,
    "fields_json" TEXT NOT NULL,
    "warnings_json" TEXT NOT NULL DEFAULT '[]',
    "attachments_json" TEXT NOT NULL DEFAULT '[]',
    "recipient_scope_json" TEXT NOT NULL DEFAULT '{}',
    "template_mapping_version_id" TEXT,
    "schedule_at" DATETIME,
    "source_snapshot_id" TEXT NOT NULL,
    "ai_generation_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "change_summary_json" TEXT NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "weekly_report_version_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_report_version_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "weekly_report_version_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "report_source_snapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_report_version_ai_generation_id_fkey" FOREIGN KEY ("ai_generation_id") REFERENCES "ai_generation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_weekly_report_version" ("ai_generation_id", "attachments_json", "change_summary_json", "content_hash", "created_at", "created_by", "fields_json", "id", "next_week_plans_text", "origin", "other_text", "parent_version_id", "problems_text", "recent_goals_text", "recipient_scope_json", "report_date_text", "report_id", "schedule_at", "source_snapshot_id", "template_mapping_version_id", "version_no", "warnings_json", "weekly_work_text") SELECT "ai_generation_id", "attachments_json", "change_summary_json", "content_hash", "created_at", "created_by", "fields_json", "id", "next_week_plans_text", "origin", "other_text", "parent_version_id", "problems_text", "recent_goals_text", "recipient_scope_json", "report_date_text", "report_id", "schedule_at", "source_snapshot_id", "template_mapping_version_id", "version_no", "warnings_json", "weekly_work_text" FROM "weekly_report_version";
DROP TABLE "weekly_report_version";
ALTER TABLE "new_weekly_report_version" RENAME TO "weekly_report_version";
CREATE INDEX "weekly_report_version_report_id_created_at_idx" ON "weekly_report_version"("report_id", "created_at");
CREATE INDEX "weekly_report_version_source_snapshot_id_idx" ON "weekly_report_version"("source_snapshot_id");
CREATE UNIQUE INDEX "weekly_report_version_report_id_version_no_key" ON "weekly_report_version"("report_id", "version_no");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ai_generation_adopted_version_id_key" ON "ai_generation"("adopted_version_id");

-- CreateIndex
CREATE INDEX "ai_generation_owner_profile_id_created_at_idx" ON "ai_generation"("owner_profile_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_generation_report_id_created_at_idx" ON "ai_generation"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_generation_provider_connection_id_provider_config_version_idx" ON "ai_generation"("provider_connection_id", "provider_config_version");

-- CreateIndex
CREATE INDEX "ai_generation_status_adoption_status_idx" ON "ai_generation"("status", "adoption_status");
