ALTER TABLE "task" ADD COLUMN "source_stable_key" TEXT;
CREATE UNIQUE INDEX "task_source_stable_key_key" ON "task"("source_stable_key");

ALTER TABLE "excel_import" ADD COLUMN "diagnostics_json" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "excel_import" ADD COLUMN "commit_summary_json" TEXT NOT NULL DEFAULT '{}';

-- SQLite 需要重建表才能补上提交任务和来源观测的外键；迁移期间仍保留全部预检行。
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_excel_import_row" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "import_id" TEXT NOT NULL,
  "sheet_name" TEXT NOT NULL,
  "row_number" INTEGER NOT NULL,
  "row_kind" TEXT NOT NULL,
  "row_fingerprint" TEXT NOT NULL,
  "raw_json" TEXT NOT NULL,
  "normalized_json" TEXT NOT NULL,
  "diagnostics_json" TEXT NOT NULL DEFAULT '[]',
  "candidates_json" TEXT NOT NULL DEFAULT '[]',
  "resolution_json" TEXT NOT NULL DEFAULT '{}',
  "proposed_action" TEXT NOT NULL,
  "commit_status" TEXT NOT NULL DEFAULT 'pending',
  "matched_task_id" TEXT,
  "committed_task_id" TEXT,
  "source_observation_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "excel_import_row_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "excel_import" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "excel_import_row_matched_task_id_fkey" FOREIGN KEY ("matched_task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "excel_import_row_committed_task_id_fkey" FOREIGN KEY ("committed_task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "excel_import_row_source_observation_id_fkey" FOREIGN KEY ("source_observation_id") REFERENCES "task_source_observation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "excel_import_row_kind_check" CHECK ("row_kind" IN ('task', 'container')),
  CONSTRAINT "excel_import_row_action_check" CHECK ("proposed_action" IN ('create_excel', 'link_jira', 'skip', 'conflict', 'blocked')),
  CONSTRAINT "excel_import_row_commit_status_check" CHECK ("commit_status" IN ('pending', 'committed', 'skipped')),
  CONSTRAINT "excel_import_row_numbers_check" CHECK ("row_number" > 0 AND "version" > 0)
);

INSERT INTO "new_excel_import_row" (
  "id", "import_id", "sheet_name", "row_number", "row_kind", "row_fingerprint",
  "raw_json", "normalized_json", "diagnostics_json", "candidates_json", "resolution_json",
  "proposed_action", "commit_status", "matched_task_id", "committed_task_id",
  "source_observation_id", "version", "created_at", "updated_at"
)
SELECT
  "id", "import_id", "sheet_name", "row_number", "row_kind", "row_fingerprint",
  "raw_json", "normalized_json", "diagnostics_json", "candidates_json", "resolution_json",
  "proposed_action", "commit_status", "matched_task_id", "committed_task_id",
  "source_observation_id", "version", "created_at", "updated_at"
FROM "excel_import_row";

DROP TABLE "excel_import_row";
ALTER TABLE "new_excel_import_row" RENAME TO "excel_import_row";
CREATE UNIQUE INDEX "excel_import_row_import_id_sheet_name_row_number_key"
  ON "excel_import_row"("import_id", "sheet_name", "row_number");
CREATE INDEX "excel_import_row_import_id_proposed_action_commit_status_idx"
  ON "excel_import_row"("import_id", "proposed_action", "commit_status");
CREATE INDEX "excel_import_row_row_fingerprint_idx" ON "excel_import_row"("row_fingerprint");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;

-- 同一任务字段只能有一个当前生效来源；历史记录不受此唯一索引限制。
CREATE UNIQUE INDEX "task_field_provenance_one_active_field_key"
  ON "task_field_provenance"("task_id", "field_name") WHERE "active" = 1;
