-- 正式日志和机器人使用独立意图/尝试事实；唯一键保证同一确认不会因重复点击产生重复外部写入。
CREATE TABLE "delivery_intent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT NOT NULL,
  "confirmation_id" TEXT NOT NULL,
  "confirmed_version_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "idempotency_record_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "target_summary_json" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "job_id" TEXT,
  "external_id" TEXT,
  "external_url" TEXT,
  "provider_request_id" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" DATETIME,
  "last_error_code" TEXT,
  "last_error_summary" TEXT,
  "completed_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "delivery_intent_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "delivery_intent_confirmation_id_fkey" FOREIGN KEY ("confirmation_id") REFERENCES "weekly_report_confirmation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "delivery_intent_confirmed_version_id_fkey" FOREIGN KEY ("confirmed_version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "delivery_intent_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "delivery_attempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "intent_id" TEXT NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "request_summary_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "http_status" INTEGER,
  "provider_error_code" TEXT,
  "provider_request_id" TEXT,
  "external_id" TEXT,
  "external_url" TEXT,
  "response_summary_json" TEXT NOT NULL DEFAULT '{}',
  "retry_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "delivery_attempt_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "delivery_intent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "delivery_intent_job_id_key" ON "delivery_intent"("job_id");
CREATE UNIQUE INDEX "delivery_intent_report_id_confirmation_id_channel_connection_id_key" ON "delivery_intent"("report_id", "confirmation_id", "channel", "connection_id");
CREATE INDEX "delivery_intent_report_id_channel_created_at_idx" ON "delivery_intent"("report_id", "channel", "created_at");
CREATE INDEX "delivery_intent_status_updated_at_idx" ON "delivery_intent"("status", "updated_at");
CREATE UNIQUE INDEX "delivery_attempt_intent_id_attempt_no_key" ON "delivery_attempt"("intent_id", "attempt_no");
CREATE INDEX "delivery_attempt_status_started_at_idx" ON "delivery_attempt"("status", "started_at");

CREATE TRIGGER "delivery_intent_validate_insert" BEFORE INSERT ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review') OR NEW."attempt_count" < 0 OR NEW."version" < 1 THEN RAISE(ABORT, 'delivery_intent values are invalid') END; END;
CREATE TRIGGER "delivery_intent_validate_update" BEFORE UPDATE ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review') OR NEW."attempt_count" < OLD."attempt_count" OR NEW."version" <= OLD."version" OR OLD."status" = 'succeeded' AND NEW."status" <> 'succeeded' OR OLD."external_id" IS NOT NULL AND NEW."external_id" <> OLD."external_id" THEN RAISE(ABORT, 'delivery_intent transition is invalid') END; END;
CREATE TRIGGER "delivery_attempt_validate_insert" BEFORE INSERT ON "delivery_attempt" BEGIN SELECT CASE WHEN NEW."attempt_no" < 1 OR NEW."status" NOT IN ('running','succeeded','failed','unknown') THEN RAISE(ABORT, 'delivery_attempt values are invalid') END; END;
CREATE TRIGGER "delivery_attempt_validate_update" BEFORE UPDATE ON "delivery_attempt" BEGIN SELECT CASE WHEN OLD."status" <> 'running' OR NEW."status" NOT IN ('succeeded','failed','unknown') OR NEW."attempt_no" <> OLD."attempt_no" OR NEW."intent_id" <> OLD."intent_id" OR NEW."request_summary_hash" <> OLD."request_summary_hash" THEN RAISE(ABORT, 'delivery_attempt transition is invalid') END; END;
