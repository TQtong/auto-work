-- CreateTable
CREATE TABLE "git_batch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "parameters_json" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "preview_hash" TEXT,
    "previewed_at" DATETIME,
    "expires_at" DATETIME,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" DATETIME,
    "approval_request_hash" TEXT,
    "execution_started_at" DATETIME,
    "execution_ended_at" DATETIME,
    "summary_json" TEXT NOT NULL DEFAULT '{}',
    "cancel_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "git_batch_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batch_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "preview_snapshot_json" TEXT NOT NULL DEFAULT '{}',
    "preview_snapshot_hash" TEXT,
    "display_command" TEXT,
    "expected_changes_json" TEXT NOT NULL DEFAULT '[]',
    "warnings_json" TEXT NOT NULL DEFAULT '[]',
    "blocking_reasons_json" TEXT NOT NULL DEFAULT '[]',
    "risk_level" TEXT NOT NULL DEFAULT 'information',
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "execution_check_json" TEXT,
    "exit_code" INTEGER,
    "result_code" TEXT,
    "result_summary" TEXT,
    "post_head_sha" TEXT,
    "output_summary" TEXT,
    "duration_ms" INTEGER,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "git_batch_item_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "git_batch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "git_batch_item_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repository" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "git_operation_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batch_item_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "worker_request_id" TEXT,
    "error_code" TEXT,
    "audit_event_id" TEXT,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "git_operation_event_batch_item_id_fkey" FOREIGN KEY ("batch_item_id") REFERENCES "git_batch_item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "git_batch_status_created_at_idx" ON "git_batch"("status", "created_at");

-- CreateIndex
CREATE INDEX "git_batch_created_by_created_at_idx" ON "git_batch"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "git_batch_item_batch_id_ordinal_idx" ON "git_batch_item"("batch_id", "ordinal");

-- CreateIndex
CREATE INDEX "git_batch_item_repository_id_created_at_idx" ON "git_batch_item"("repository_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "git_batch_item_batch_id_repository_id_key" ON "git_batch_item"("batch_id", "repository_id");

-- CreateIndex
CREATE INDEX "git_operation_event_occurred_at_idx" ON "git_operation_event"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "git_operation_event_batch_item_id_sequence_key" ON "git_operation_event"("batch_item_id", "sequence");
