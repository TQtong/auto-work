CREATE TABLE "weekly_report_content_template" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "profile_id" TEXT NOT NULL,
  "recent_goals_text" TEXT NOT NULL DEFAULT '',
  "weekly_work_text" TEXT NOT NULL DEFAULT '',
  "next_week_plans_text" TEXT NOT NULL DEFAULT '',
  "problems_text" TEXT NOT NULL DEFAULT '',
  "other_text" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "weekly_report_content_template_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "user_profile" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "weekly_report_content_template_profile_id_key"
  ON "weekly_report_content_template"("profile_id");
