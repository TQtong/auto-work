CREATE TABLE "excel_import" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "file_name" TEXT NOT NULL,
  "file_sha256" TEXT NOT NULL,
  "file_size_bytes" INTEGER NOT NULL,
  "parser_version" TEXT NOT NULL,
  "date_system" TEXT NOT NULL,
  "workday_hours" REAL NOT NULL DEFAULT 8,
  "status" TEXT NOT NULL DEFAULT 'preview_ready',
  "sheet_summary_json" TEXT NOT NULL DEFAULT '[]',
  "ignored_columns_json" TEXT NOT NULL DEFAULT '[]',
  "blocking_count" INTEGER NOT NULL DEFAULT 0,
  "conflict_count" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "info_count" INTEGER NOT NULL DEFAULT 0,
  "task_row_count" INTEGER NOT NULL DEFAULT 0,
  "container_row_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "error_summary" TEXT,
  "created_by" TEXT NOT NULL,
  "committed_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "excel_import_date_system_check" CHECK ("date_system" IN ('1900', '1904')),
  CONSTRAINT "excel_import_status_check" CHECK ("status" IN ('preview_ready', 'committed', 'failed')),
  CONSTRAINT "excel_import_workday_hours_check" CHECK ("workday_hours" > 0 AND "workday_hours" <= 24),
  CONSTRAINT "excel_import_counts_check" CHECK (
    "file_size_bytes" >= 0 AND "blocking_count" >= 0 AND "conflict_count" >= 0 AND
    "warning_count" >= 0 AND "info_count" >= 0 AND "task_row_count" >= 0 AND
    "container_row_count" >= 0 AND "version" > 0
  )
);

CREATE UNIQUE INDEX "excel_import_file_sha256_parser_version_key"
  ON "excel_import"("file_sha256", "parser_version");
CREATE INDEX "excel_import_status_created_at_idx" ON "excel_import"("status", "created_at");

CREATE TABLE "excel_import_row" (
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
  CONSTRAINT "excel_import_row_kind_check" CHECK ("row_kind" IN ('task', 'container')),
  CONSTRAINT "excel_import_row_action_check" CHECK ("proposed_action" IN ('create_excel', 'link_jira', 'skip', 'conflict', 'blocked')),
  CONSTRAINT "excel_import_row_commit_status_check" CHECK ("commit_status" IN ('pending', 'committed', 'skipped')),
  CONSTRAINT "excel_import_row_numbers_check" CHECK ("row_number" > 0 AND "version" > 0)
);

CREATE UNIQUE INDEX "excel_import_row_import_id_sheet_name_row_number_key"
  ON "excel_import_row"("import_id", "sheet_name", "row_number");
CREATE INDEX "excel_import_row_import_id_proposed_action_commit_status_idx"
  ON "excel_import_row"("import_id", "proposed_action", "commit_status");
CREATE INDEX "excel_import_row_row_fingerprint_idx" ON "excel_import_row"("row_fingerprint");

CREATE TABLE "task_field_provenance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "field_name" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "value_json" TEXT NOT NULL,
  "source_observation_id" TEXT,
  "excel_import_row_id" TEXT,
  "reason" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "effective_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "superseded_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_field_provenance_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_field_provenance_source_observation_id_fkey" FOREIGN KEY ("source_observation_id") REFERENCES "task_source_observation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_field_provenance_excel_import_row_id_fkey" FOREIGN KEY ("excel_import_row_id") REFERENCES "excel_import_row" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_field_provenance_source_type_check" CHECK ("source_type" IN ('jira', 'excel', 'manual')),
  CONSTRAINT "task_field_provenance_decision_check" CHECK ("decision" IN ('source_fact', 'supplement', 'keep_jira', 'override', 'superseded'))
);

CREATE INDEX "task_field_provenance_task_id_field_name_active_idx"
  ON "task_field_provenance"("task_id", "field_name", "active");
CREATE INDEX "task_field_provenance_excel_import_row_id_idx"
  ON "task_field_provenance"("excel_import_row_id");
