CREATE TABLE "weekly_report_reminder_policy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "profile_id" TEXT NOT NULL,
  "robot_connection_id" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  "working_weekdays_json" TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  "generation_enabled" BOOLEAN NOT NULL DEFAULT true,
  "generation_weekday" INTEGER NOT NULL DEFAULT 5,
  "generation_time" TEXT NOT NULL DEFAULT '14:00',
  "confirmation_enabled" BOOLEAN NOT NULL DEFAULT true,
  "confirmation_weekday" INTEGER NOT NULL DEFAULT 5,
  "confirmation_time" TEXT NOT NULL DEFAULT '16:00',
  "deadline_enabled" BOOLEAN NOT NULL DEFAULT true,
  "deadline_weekday" INTEGER NOT NULL DEFAULT 5,
  "deadline_time" TEXT NOT NULL DEFAULT '17:30',
  "grace_minutes" INTEGER NOT NULL DEFAULT 120,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "weekly_report_reminder_policy_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_reminder_policy_robot_connection_id_fkey" FOREIGN KEY ("robot_connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "weekly_report_reminder_policy_profile_id_key" ON "weekly_report_reminder_policy"("profile_id");
CREATE INDEX "weekly_report_reminder_policy_enabled_updated_at_idx" ON "weekly_report_reminder_policy"("enabled", "updated_at");

CREATE TRIGGER "weekly_report_reminder_policy_validate_insert" BEFORE INSERT ON "weekly_report_reminder_policy" BEGIN SELECT CASE WHEN NEW."timezone" <> 'Asia/Shanghai' OR NEW."grace_minutes" < 0 OR NEW."grace_minutes" > 1440 OR NEW."version" < 1 OR NEW."generation_weekday" < 1 OR NEW."generation_weekday" > 7 OR NEW."confirmation_weekday" < 1 OR NEW."confirmation_weekday" > 7 OR NEW."deadline_weekday" < 1 OR NEW."deadline_weekday" > 7 OR NEW."generation_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."generation_time", 1, 2) AS INTEGER) > 23 OR NEW."confirmation_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."confirmation_time", 1, 2) AS INTEGER) > 23 OR NEW."deadline_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."deadline_time", 1, 2) AS INTEGER) > 23 OR (NEW."enabled" = true AND NEW."robot_connection_id" IS NULL) THEN RAISE(ABORT, 'weekly reminder policy values are invalid') END; END;
CREATE TRIGGER "weekly_report_reminder_policy_validate_update" BEFORE UPDATE ON "weekly_report_reminder_policy" BEGIN SELECT CASE WHEN NEW."timezone" <> 'Asia/Shanghai' OR NEW."grace_minutes" < 0 OR NEW."grace_minutes" > 1440 OR NEW."version" <= OLD."version" OR NEW."generation_weekday" < 1 OR NEW."generation_weekday" > 7 OR NEW."confirmation_weekday" < 1 OR NEW."confirmation_weekday" > 7 OR NEW."deadline_weekday" < 1 OR NEW."deadline_weekday" > 7 OR NEW."generation_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."generation_time", 1, 2) AS INTEGER) > 23 OR NEW."confirmation_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."confirmation_time", 1, 2) AS INTEGER) > 23 OR NEW."deadline_time" NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR CAST(substr(NEW."deadline_time", 1, 2) AS INTEGER) > 23 OR (NEW."enabled" = true AND NEW."robot_connection_id" IS NULL) THEN RAISE(ABORT, 'weekly reminder policy transition is invalid') END; END;
