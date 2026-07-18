PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

DROP TRIGGER "robot_notification_validate_insert";
DROP TRIGGER "robot_notification_validate_update";

CREATE TABLE "new_robot_notification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT,
  "connection_id" TEXT NOT NULL,
  "delivery_intent_id" TEXT,
  "notification_type" TEXT NOT NULL,
  "business_object_key" TEXT NOT NULL,
  "state_version" INTEGER NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "quiet_window_started_at" DATETIME NOT NULL,
  "quiet_window_ends_at" DATETIME NOT NULL,
  "coalesced_count" INTEGER NOT NULL DEFAULT 0,
  "scheduled_for" DATETIME NOT NULL,
  "job_id" TEXT,
  "last_attempt_at" DATETIME,
  "sent_at" DATETIME,
  "skipped_at" DATETIME,
  "skip_reason" TEXT,
  "provider_request_id" TEXT,
  "last_error_code" TEXT,
  "last_error_summary" TEXT,
  "message_facts_json" TEXT NOT NULL DEFAULT '{}',
  "provider_call_count" INTEGER NOT NULL DEFAULT 0,
  "retry_delays_json" TEXT NOT NULL DEFAULT '[]',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "robot_notification_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "robot_notification_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "robot_notification_delivery_intent_id_fkey" FOREIGN KEY ("delivery_intent_id") REFERENCES "delivery_intent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_robot_notification" ("id","report_id","connection_id","delivery_intent_id","notification_type","business_object_key","state_version","dedupe_key","content_hash","status","quiet_window_started_at","quiet_window_ends_at","coalesced_count","scheduled_for","job_id","last_attempt_at","sent_at","skipped_at","skip_reason","provider_request_id","last_error_code","last_error_summary","message_facts_json","provider_call_count","retry_delays_json","version","created_at","updated_at") SELECT "id","report_id","connection_id","delivery_intent_id","notification_type","business_object_key","state_version","dedupe_key","content_hash","status","quiet_window_started_at","quiet_window_ends_at","coalesced_count","scheduled_for","job_id","last_attempt_at","sent_at","skipped_at","skip_reason","provider_request_id","last_error_code","last_error_summary","message_facts_json","provider_call_count","retry_delays_json","version","created_at","updated_at" FROM "robot_notification";
DROP TABLE "robot_notification";
ALTER TABLE "new_robot_notification" RENAME TO "robot_notification";

CREATE UNIQUE INDEX "robot_notification_delivery_intent_id_key" ON "robot_notification"("delivery_intent_id");
CREATE UNIQUE INDEX "robot_notification_dedupe_key_key" ON "robot_notification"("dedupe_key");
CREATE UNIQUE INDEX "robot_notification_job_id_key" ON "robot_notification"("job_id");
CREATE INDEX "robot_notification_report_id_notification_type_created_at_idx" ON "robot_notification"("report_id", "notification_type", "created_at");
CREATE INDEX "robot_notification_status_scheduled_for_idx" ON "robot_notification"("status", "scheduled_for");
CREATE INDEX "robot_notification_business_object_key_notification_type_content_hash_quiet_window_ends_at_idx" ON "robot_notification"("business_object_key", "notification_type", "content_hash", "quiet_window_ends_at");

CREATE TRIGGER "robot_notification_validate_insert" BEFORE INSERT ON "robot_notification" BEGIN SELECT CASE WHEN NEW."notification_type" NOT IN ('generation_reminder','confirmation_reminder','deadline_reminder','submission_success','submission_failure','risk_alert') OR NEW."status" NOT IN ('pending','queued','sending','succeeded','failed','unknown','skipped','cancelled') OR NEW."state_version" < 1 OR NEW."coalesced_count" < 0 OR NEW."provider_call_count" < 0 OR NEW."provider_call_count" > 9 OR NEW."version" < 1 OR NEW."quiet_window_ends_at" < NEW."quiet_window_started_at" OR length(NEW."business_object_key") < 1 OR length(NEW."dedupe_key") < 1 OR length(NEW."content_hash") < 32 OR (NEW."status" = 'skipped' AND (NEW."skipped_at" IS NULL OR length(COALESCE(NEW."skip_reason", '')) < 1)) THEN RAISE(ABORT, 'robot_notification values are invalid') END; END;
CREATE TRIGGER "robot_notification_validate_update" BEFORE UPDATE ON "robot_notification" BEGIN SELECT CASE WHEN NEW."notification_type" <> OLD."notification_type" OR NEW."business_object_key" <> OLD."business_object_key" OR NEW."state_version" <> OLD."state_version" OR NEW."dedupe_key" <> OLD."dedupe_key" OR NEW."content_hash" <> OLD."content_hash" OR NEW."message_facts_json" <> OLD."message_facts_json" OR COALESCE(NEW."delivery_intent_id", '') <> COALESCE(OLD."delivery_intent_id", '') OR COALESCE(NEW."report_id", '') <> COALESCE(OLD."report_id", '') OR NEW."coalesced_count" < OLD."coalesced_count" OR NEW."provider_call_count" < OLD."provider_call_count" OR NEW."version" <= OLD."version" OR (OLD."status" IN ('succeeded','skipped','cancelled') AND NEW."status" <> OLD."status") OR (NEW."status" = 'skipped' AND (NEW."skipped_at" IS NULL OR length(COALESCE(NEW."skip_reason", '')) < 1)) THEN RAISE(ABORT, 'robot_notification transition is invalid') END; END;

CREATE TABLE "weekly_report_reminder_occurrence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "policy_id" TEXT NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "reminder_type" TEXT NOT NULL,
  "cycle_key" TEXT NOT NULL,
  "period_start" TEXT NOT NULL,
  "period_end" TEXT NOT NULL,
  "report_date" TEXT NOT NULL,
  "scheduled_for" DATETIME NOT NULL,
  "grace_until" DATETIME NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "report_id" TEXT,
  "notification_id" TEXT,
  "job_id" TEXT,
  "queued_at" DATETIME,
  "skipped_at" DATETIME,
  "skip_reason" TEXT,
  "completed_at" DATETIME,
  "last_error_code" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "weekly_report_reminder_occurrence_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "weekly_report_reminder_policy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_reminder_occurrence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_reminder_occurrence_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "robot_notification" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "weekly_report_reminder_occurrence_notification_id_key" ON "weekly_report_reminder_occurrence"("notification_id");
CREATE UNIQUE INDEX "weekly_report_reminder_occurrence_job_id_key" ON "weekly_report_reminder_occurrence"("job_id");
CREATE UNIQUE INDEX "weekly_report_reminder_occurrence_policy_id_policy_version_cycle_key_reminder_type_key" ON "weekly_report_reminder_occurrence"("policy_id", "policy_version", "cycle_key", "reminder_type");
CREATE INDEX "weekly_report_reminder_occurrence_status_scheduled_for_idx" ON "weekly_report_reminder_occurrence"("status", "scheduled_for");
CREATE INDEX "weekly_report_reminder_occurrence_policy_id_created_at_idx" ON "weekly_report_reminder_occurrence"("policy_id", "created_at");

CREATE TRIGGER "weekly_report_reminder_occurrence_validate_insert" BEFORE INSERT ON "weekly_report_reminder_occurrence" BEGIN SELECT CASE WHEN NEW."reminder_type" NOT IN ('generation_reminder','confirmation_reminder','deadline_reminder') OR NEW."status" NOT IN ('planned','queued','succeeded','failed','unknown','skipped','cancelled') OR NEW."policy_version" < 1 OR NEW."version" < 1 OR NEW."grace_until" < NEW."scheduled_for" OR (NEW."status" = 'planned' AND (NEW."notification_id" IS NOT NULL OR NEW."job_id" IS NOT NULL)) OR (NEW."status" = 'queued' AND (NEW."notification_id" IS NULL OR NEW."job_id" IS NULL OR NEW."queued_at" IS NULL)) OR (NEW."status" = 'skipped' AND (NEW."notification_id" IS NULL OR NEW."skipped_at" IS NULL OR length(COALESCE(NEW."skip_reason", '')) < 1)) THEN RAISE(ABORT, 'weekly reminder occurrence values are invalid') END; END;
CREATE TRIGGER "weekly_report_reminder_occurrence_validate_update" BEFORE UPDATE ON "weekly_report_reminder_occurrence" BEGIN SELECT CASE WHEN NEW."policy_id" <> OLD."policy_id" OR NEW."policy_version" <> OLD."policy_version" OR NEW."reminder_type" <> OLD."reminder_type" OR NEW."cycle_key" <> OLD."cycle_key" OR NEW."period_start" <> OLD."period_start" OR NEW."period_end" <> OLD."period_end" OR NEW."report_date" <> OLD."report_date" OR NEW."scheduled_for" <> OLD."scheduled_for" OR NEW."grace_until" <> OLD."grace_until" OR NEW."version" <= OLD."version" OR (OLD."status" IN ('succeeded','failed','unknown','skipped','cancelled') AND NEW."status" <> OLD."status") OR (OLD."status" = 'planned' AND NEW."status" NOT IN ('queued','skipped','cancelled')) OR (OLD."status" = 'queued' AND NEW."status" NOT IN ('succeeded','failed','unknown','cancelled')) OR (NEW."status" = 'queued' AND (NEW."notification_id" IS NULL OR NEW."job_id" IS NULL OR NEW."queued_at" IS NULL)) OR (NEW."status" = 'skipped' AND (NEW."notification_id" IS NULL OR NEW."skipped_at" IS NULL OR length(COALESCE(NEW."skip_reason", '')) < 1)) OR (NEW."status" IN ('succeeded','failed','unknown') AND NEW."completed_at" IS NULL) THEN RAISE(ABORT, 'weekly reminder occurrence transition is invalid') END; END;

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
