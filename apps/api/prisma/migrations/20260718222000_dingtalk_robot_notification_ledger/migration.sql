-- 通知账本只保存消息摘要哈希、调度和发送结果，完整周报与机器人凭证不得进入本表。
CREATE TABLE "robot_notification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT NOT NULL,
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
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "robot_notification_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "robot_notification_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "robot_notification_delivery_intent_id_fkey" FOREIGN KEY ("delivery_intent_id") REFERENCES "delivery_intent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "robot_notification_delivery_intent_id_key" ON "robot_notification"("delivery_intent_id");
CREATE UNIQUE INDEX "robot_notification_dedupe_key_key" ON "robot_notification"("dedupe_key");
CREATE UNIQUE INDEX "robot_notification_job_id_key" ON "robot_notification"("job_id");
CREATE INDEX "robot_notification_report_id_notification_type_created_at_idx" ON "robot_notification"("report_id", "notification_type", "created_at");
CREATE INDEX "robot_notification_status_scheduled_for_idx" ON "robot_notification"("status", "scheduled_for");
CREATE INDEX "robot_notification_business_object_key_notification_type_content_hash_quiet_window_ends_at_idx" ON "robot_notification"("business_object_key", "notification_type", "content_hash", "quiet_window_ends_at");

CREATE TRIGGER "robot_notification_validate_insert" BEFORE INSERT ON "robot_notification" BEGIN SELECT CASE WHEN NEW."notification_type" NOT IN ('deadline_reminder','submission_success','submission_failure','risk_alert') OR NEW."status" NOT IN ('pending','queued','sending','succeeded','failed','unknown','skipped','cancelled') OR NEW."state_version" < 1 OR NEW."coalesced_count" < 0 OR NEW."version" < 1 OR NEW."quiet_window_ends_at" < NEW."quiet_window_started_at" OR length(NEW."business_object_key") < 1 OR length(NEW."dedupe_key") < 1 OR length(NEW."content_hash") < 32 THEN RAISE(ABORT, 'robot_notification values are invalid') END; END;

CREATE TRIGGER "robot_notification_validate_update" BEFORE UPDATE ON "robot_notification" BEGIN SELECT CASE WHEN NEW."notification_type" <> OLD."notification_type" OR NEW."business_object_key" <> OLD."business_object_key" OR NEW."state_version" <> OLD."state_version" OR NEW."dedupe_key" <> OLD."dedupe_key" OR NEW."content_hash" <> OLD."content_hash" OR COALESCE(NEW."delivery_intent_id", '') <> COALESCE(OLD."delivery_intent_id", '') OR NEW."coalesced_count" < OLD."coalesced_count" OR NEW."version" <= OLD."version" OR OLD."status" IN ('succeeded','skipped','cancelled') AND NEW."status" <> OLD."status" THEN RAISE(ABORT, 'robot_notification transition is invalid') END; END;
