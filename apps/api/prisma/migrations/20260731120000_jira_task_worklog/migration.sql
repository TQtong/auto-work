CREATE TABLE "task_worklog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "author_external_id" TEXT,
  "author_name" TEXT,
  "is_current_user" BOOLEAN NOT NULL DEFAULT false,
  "started_at" DATETIME NOT NULL,
  "business_date" TEXT NOT NULL,
  "time_spent_seconds" INTEGER NOT NULL,
  "external_updated_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "task_worklog_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_worklog_task_id_external_id_key"
  ON "task_worklog"("task_id", "external_id");

CREATE INDEX "task_worklog_task_id_is_current_user_business_date_idx"
  ON "task_worklog"("task_id", "is_current_user", "business_date");
