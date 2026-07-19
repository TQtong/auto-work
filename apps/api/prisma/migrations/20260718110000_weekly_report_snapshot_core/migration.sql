CREATE TABLE "work_calendar" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "current_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "work_calendar_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "work_calendar_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "work_calendar_version_check" CHECK ("version" > 0)
);

CREATE TABLE "work_calendar_version" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "calendar_id" TEXT NOT NULL,
  "version_no" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  "working_weekdays_json" TEXT NOT NULL,
  "date_overrides_json" TEXT NOT NULL DEFAULT '[]',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "content_hash" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_calendar_version_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendar" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "work_calendar_version_no_check" CHECK ("version_no" > 0),
  CONSTRAINT "work_calendar_timezone_check" CHECK ("timezone" = 'Asia/Shanghai'),
  CONSTRAINT "work_calendar_source_check" CHECK ("source" IN ('manual', 'imported'))
);

CREATE TABLE "weekly_report" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_profile_id" TEXT NOT NULL,
  "period_start" TEXT NOT NULL,
  "period_end" TEXT NOT NULL,
  "report_date" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  "template_name" TEXT NOT NULL DEFAULT 'uTwin产研创新部周报',
  "template_mapping_version_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'collecting',
  "log_delivery_state" TEXT NOT NULL DEFAULT 'not_started',
  "robot_delivery_state" TEXT NOT NULL DEFAULT 'not_started',
  "current_version_id" TEXT,
  "confirmed_version_id" TEXT,
  "recipient_scope_version" INTEGER NOT NULL DEFAULT 1,
  "schedule_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archived_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "weekly_report_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_confirmed_version_id_fkey" FOREIGN KEY ("confirmed_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_period_check" CHECK ("period_start" <= "period_end"),
  CONSTRAINT "weekly_report_timezone_check" CHECK ("timezone" = 'Asia/Shanghai'),
  CONSTRAINT "weekly_report_status_check" CHECK ("status" IN ('collecting', 'generated', 'editing', 'confirmed')),
  CONSTRAINT "weekly_report_log_delivery_check" CHECK ("log_delivery_state" IN ('not_started', 'submitting', 'submitted', 'failed', 'unknown')),
  CONSTRAINT "weekly_report_robot_delivery_check" CHECK ("robot_delivery_state" IN ('not_started', 'notified', 'failed', 'skipped')),
  CONSTRAINT "weekly_report_version_check" CHECK ("version" > 0),
  CONSTRAINT "weekly_report_recipient_scope_version_check" CHECK ("recipient_scope_version" > 0)
);

CREATE TABLE "report_source_snapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT NOT NULL,
  "period_start" TEXT NOT NULL,
  "period_end" TEXT NOT NULL,
  "report_date" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "calendar_version_id" TEXT,
  "profile_id" TEXT NOT NULL,
  "profile_version" INTEGER NOT NULL,
  "jira_query_json" TEXT NOT NULL DEFAULT '{}',
  "jira_sync_run_ids_json" TEXT NOT NULL DEFAULT '[]',
  "task_facts_json" TEXT NOT NULL,
  "evidence_facts_json" TEXT NOT NULL,
  "manual_inputs_json" TEXT NOT NULL DEFAULT '[]',
  "freshness_policy_json" TEXT NOT NULL,
  "warnings_json" TEXT NOT NULL DEFAULT '[]',
  "rule_version" TEXT NOT NULL,
  "template_mapping_version_id" TEXT,
  "sanitization_policy_version" TEXT NOT NULL,
  "generation_hash" TEXT NOT NULL,
  "source_content_hash" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_source_snapshot_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_snapshot_calendar_version_id_fkey" FOREIGN KEY ("calendar_version_id") REFERENCES "work_calendar_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_snapshot_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_snapshot_profile_version_check" CHECK ("profile_version" > 0),
  CONSTRAINT "report_source_snapshot_timezone_check" CHECK ("timezone" = 'Asia/Shanghai')
);

CREATE TABLE "weekly_report_version" (
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
  "source_snapshot_id" TEXT NOT NULL,
  "ai_generation_id" TEXT,
  "content_hash" TEXT NOT NULL,
  "change_summary_json" TEXT NOT NULL DEFAULT '{}',
  "created_by" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "weekly_report_version_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_version_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_version_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "report_source_snapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_version_no_check" CHECK ("version_no" > 0),
  CONSTRAINT "weekly_report_version_origin_check" CHECK ("origin" IN ('rule', 'ai', 'manual', 'restore')),
  CONSTRAINT "weekly_report_version_problems_check" CHECK (length(trim("problems_text")) > 0)
);

CREATE TABLE "report_source_link" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "snapshot_id" TEXT NOT NULL,
  "version_id" TEXT NOT NULL,
  "field_name" TEXT NOT NULL,
  "block_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "task_id" TEXT,
  "evidence_id" TEXT,
  "source_content_hash" TEXT NOT NULL,
  "source_summary_json" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_source_link_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "report_source_snapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_link_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_link_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_link_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "report_source_link_field_check" CHECK ("field_name" IN ('recentGoals', 'weeklyWork', 'nextWeekPlans', 'problems', 'other')),
  CONSTRAINT "report_source_link_type_check" CHECK ("source_type" IN ('task', 'evidence', 'manual')),
  CONSTRAINT "report_source_link_reference_check" CHECK (
    ("source_type" = 'task' AND "task_id" = "source_id" AND "evidence_id" IS NULL) OR
    ("source_type" = 'evidence' AND "evidence_id" = "source_id" AND "task_id" IS NULL) OR
    ("source_type" = 'manual' AND "task_id" IS NULL AND "evidence_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "work_calendar_current_version_id_key" ON "work_calendar"("current_version_id");
CREATE UNIQUE INDEX "work_calendar_version_calendar_id_version_no_key" ON "work_calendar_version"("calendar_id", "version_no");
CREATE UNIQUE INDEX "weekly_report_current_version_id_key" ON "weekly_report"("current_version_id");
CREATE UNIQUE INDEX "weekly_report_confirmed_version_id_key" ON "weekly_report"("confirmed_version_id");
CREATE UNIQUE INDEX "weekly_report_active_period_unique" ON "weekly_report"("owner_profile_id", "period_start", "period_end") WHERE "archived_at" IS NULL;
CREATE INDEX "weekly_report_owner_profile_id_period_start_period_end_idx" ON "weekly_report"("owner_profile_id", "period_start", "period_end");
CREATE INDEX "weekly_report_status_updated_at_idx" ON "weekly_report"("status", "updated_at");

CREATE UNIQUE INDEX "report_source_snapshot_report_id_generation_hash_key" ON "report_source_snapshot"("report_id", "generation_hash");
CREATE INDEX "report_source_snapshot_profile_id_period_start_period_end_idx" ON "report_source_snapshot"("profile_id", "period_start", "period_end");

CREATE UNIQUE INDEX "weekly_report_version_report_id_version_no_key" ON "weekly_report_version"("report_id", "version_no");
CREATE INDEX "weekly_report_version_report_id_created_at_idx" ON "weekly_report_version"("report_id", "created_at");
CREATE INDEX "weekly_report_version_source_snapshot_id_idx" ON "weekly_report_version"("source_snapshot_id");

CREATE UNIQUE INDEX "report_source_link_version_id_field_name_block_id_source_type_source_id_key" ON "report_source_link"("version_id", "field_name", "block_id", "source_type", "source_id");
CREATE INDEX "report_source_link_snapshot_id_idx" ON "report_source_link"("snapshot_id");
CREATE INDEX "report_source_link_source_type_source_id_idx" ON "report_source_link"("source_type", "source_id");

-- 以下触发器把来源事实和版本正文固定为只追加记录，防止任何服务误用 UPDATE 静默改写历史。
CREATE TRIGGER "work_calendar_version_immutable_update" BEFORE UPDATE ON "work_calendar_version" BEGIN SELECT RAISE(ABORT, 'work_calendar_version is immutable'); END;

CREATE TRIGGER "report_source_snapshot_immutable_update" BEFORE UPDATE ON "report_source_snapshot" BEGIN SELECT RAISE(ABORT, 'report_source_snapshot is immutable'); END;

CREATE TRIGGER "weekly_report_version_immutable_update" BEFORE UPDATE ON "weekly_report_version" BEGIN SELECT RAISE(ABORT, 'weekly_report_version is immutable'); END;

CREATE TRIGGER "report_source_link_immutable_update" BEFORE UPDATE ON "report_source_link" BEGIN SELECT RAISE(ABORT, 'report_source_link is immutable'); END;
