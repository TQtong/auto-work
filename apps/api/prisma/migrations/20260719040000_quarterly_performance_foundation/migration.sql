-- CreateTable
CREATE TABLE "quarterly_review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "next_period_start" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "natural_quarter" BOOLEAN NOT NULL DEFAULT true,
    "year" INTEGER,
    "quarter" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "completeness_json" TEXT NOT NULL DEFAULT '{}',
    "metric_template_version_id" TEXT,
    "current_narrative_version_id" TEXT,
    "current_confirmation_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "quarterly_review_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quarterly_review_metric_template_version_id_fkey" FOREIGN KEY ("metric_template_version_id") REFERENCES "performance_metric_template_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quarterly_review_current_narrative_version_id_fkey" FOREIGN KEY ("current_narrative_version_id") REFERENCES "review_narrative_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quarterly_review_current_confirmation_id_fkey" FOREIGN KEY ("current_confirmation_id") REFERENCES "quarterly_review_confirmation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "quarterly_collection_snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "source_selection_json" TEXT NOT NULL,
    "freshness_policy_json" TEXT NOT NULL,
    "task_facts_json" TEXT NOT NULL DEFAULT '[]',
    "evidence_facts_json" TEXT NOT NULL DEFAULT '[]',
    "weekly_report_facts_json" TEXT NOT NULL DEFAULT '[]',
    "warnings_json" TEXT NOT NULL DEFAULT '[]',
    "source_content_hash" TEXT NOT NULL,
    "generation_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quarterly_collection_snapshot_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "achievement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "collection_snapshot_id" TEXT,
    "project_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "situation" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "contribution_boundary" TEXT NOT NULL DEFAULT '',
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "selection_status" TEXT NOT NULL DEFAULT 'candidate',
    "exclusion_reason" TEXT,
    "evidence_status" TEXT NOT NULL DEFAULT 'needs_evidence',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "achievement_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "achievement_collection_snapshot_id_fkey" FOREIGN KEY ("collection_snapshot_id") REFERENCES "quarterly_collection_snapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "achievement_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "achievement_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "achievement_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "task_id" TEXT,
    "evidence_id" TEXT,
    "title" TEXT NOT NULL,
    "external_key" TEXT,
    "url" TEXT,
    "event_at" DATETIME,
    "availability_state" TEXT NOT NULL DEFAULT 'available',
    "source_content_hash" TEXT NOT NULL,
    "source_summary_json" TEXT NOT NULL DEFAULT '{}',
    "contribution_angle" TEXT NOT NULL DEFAULT '',
    "primary_evidence" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "achievement_evidence_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "achievement_evidence_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "achievement_evidence_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "performance_metric_template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "current_version_id" TEXT,
    "archived_at" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "performance_metric_template_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "user_profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "performance_metric_template_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "performance_metric_template_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "performance_metric_template_version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "formula_type" TEXT NOT NULL,
    "rounding_rule" TEXT NOT NULL,
    "formula_config_json" TEXT NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "performance_metric_template_version_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "performance_metric_template" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "performance_metric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_version_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "weight" REAL NOT NULL,
    "minimum" REAL NOT NULL,
    "maximum" REAL NOT NULL,
    "step" REAL NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "evidence_requirement_json" TEXT NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "performance_metric_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "performance_metric_template_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "achievement_metric_link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "achievement_id" TEXT NOT NULL,
    "metric_id" TEXT NOT NULL,
    "contribution" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "achievement_metric_link_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "achievement_metric_link_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "performance_metric" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "score_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "metric_id" TEXT NOT NULL,
    "ai_suggested_score" REAL,
    "ai_suggested_minimum" REAL,
    "ai_suggested_maximum" REAL,
    "ai_reason" TEXT,
    "ai_evidence_gaps_json" TEXT NOT NULL DEFAULT '[]',
    "ai_uncertainty" TEXT,
    "ai_generation_id" TEXT,
    "user_score" REAL,
    "user_reason" TEXT,
    "raw_contribution" REAL,
    "validation_status" TEXT NOT NULL DEFAULT 'missing',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "score_item_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "score_item_metric_id_fkey" FOREIGN KEY ("metric_id") REFERENCES "performance_metric" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "review_narrative_version" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "parent_version_id" TEXT,
    "content_json" TEXT NOT NULL,
    "source_snapshot_hash" TEXT NOT NULL,
    "ai_generation_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "change_summary_json" TEXT NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_narrative_version_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "review_narrative_version_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "review_narrative_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "quarterly_review_confirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "review_version" INTEGER NOT NULL,
    "metric_template_version_id" TEXT NOT NULL,
    "narrative_version_id" TEXT NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "achievements_hash" TEXT NOT NULL,
    "scores_hash" TEXT NOT NULL,
    "calculation_json" TEXT NOT NULL,
    "completeness_ack_json" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "confirmed_by" TEXT NOT NULL,
    "confirmed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" DATETIME,
    "invalidation_reason" TEXT,
    CONSTRAINT "quarterly_review_confirmation_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quarterly_review_confirmation_metric_template_version_id_fkey" FOREIGN KEY ("metric_template_version_id") REFERENCES "performance_metric_template_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "quarterly_review_confirmation_narrative_version_id_fkey" FOREIGN KEY ("narrative_version_id") REFERENCES "review_narrative_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "export_artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "review_id" TEXT NOT NULL,
    "confirmation_id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "input_snapshot_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "job_id" TEXT,
    "file_name" TEXT,
    "stored_name" TEXT,
    "mime_type" TEXT,
    "content_hash" TEXT,
    "size_bytes" INTEGER,
    "error_code" TEXT,
    "error_summary" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    CONSTRAINT "export_artifact_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "quarterly_review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "export_artifact_confirmation_id_fkey" FOREIGN KEY ("confirmation_id") REFERENCES "quarterly_review_confirmation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_review_current_narrative_version_id_key" ON "quarterly_review"("current_narrative_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_review_current_confirmation_id_key" ON "quarterly_review"("current_confirmation_id");

-- CreateIndex
CREATE INDEX "quarterly_review_owner_profile_id_status_updated_at_idx" ON "quarterly_review"("owner_profile_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_review_owner_profile_id_period_start_period_end_key" ON "quarterly_review"("owner_profile_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_review_owner_profile_id_name_key" ON "quarterly_review"("owner_profile_id", "name");

-- CreateIndex
CREATE INDEX "quarterly_collection_snapshot_review_id_created_at_idx" ON "quarterly_collection_snapshot"("review_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_collection_snapshot_review_id_sequence_no_key" ON "quarterly_collection_snapshot"("review_id", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "quarterly_collection_snapshot_review_id_generation_hash_key" ON "quarterly_collection_snapshot"("review_id", "generation_hash");

-- CreateIndex
CREATE INDEX "achievement_review_id_selection_status_sort_order_idx" ON "achievement"("review_id", "selection_status", "sort_order");

-- CreateIndex
CREATE INDEX "achievement_project_id_period_start_period_end_idx" ON "achievement"("project_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_review_id_source_key_key" ON "achievement"("review_id", "source_key");

-- CreateIndex
CREATE INDEX "achievement_evidence_task_id_idx" ON "achievement_evidence"("task_id");

-- CreateIndex
CREATE INDEX "achievement_evidence_evidence_id_idx" ON "achievement_evidence"("evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_evidence_achievement_id_source_type_source_id_key" ON "achievement_evidence"("achievement_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metric_template_current_version_id_key" ON "performance_metric_template"("current_version_id");

-- CreateIndex
CREATE INDEX "performance_metric_template_owner_profile_id_archived_at_idx" ON "performance_metric_template"("owner_profile_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metric_template_owner_profile_id_name_key" ON "performance_metric_template"("owner_profile_id", "name");

-- CreateIndex
CREATE INDEX "performance_metric_template_version_template_id_created_at_idx" ON "performance_metric_template_version"("template_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metric_template_version_template_id_version_no_key" ON "performance_metric_template_version"("template_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metric_template_version_id_code_key" ON "performance_metric"("template_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metric_template_version_id_sort_order_key" ON "performance_metric"("template_version_id", "sort_order");

-- CreateIndex
CREATE INDEX "achievement_metric_link_metric_id_idx" ON "achievement_metric_link"("metric_id");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_metric_link_achievement_id_metric_id_key" ON "achievement_metric_link"("achievement_id", "metric_id");

-- CreateIndex
CREATE INDEX "score_item_review_id_validation_status_idx" ON "score_item"("review_id", "validation_status");

-- CreateIndex
CREATE UNIQUE INDEX "score_item_review_id_metric_id_key" ON "score_item"("review_id", "metric_id");

-- CreateIndex
CREATE INDEX "review_narrative_version_review_id_created_at_idx" ON "review_narrative_version"("review_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_narrative_version_review_id_version_no_key" ON "review_narrative_version"("review_id", "version_no");

-- CreateIndex
CREATE INDEX "quarterly_review_confirmation_review_id_status_confirmed_at_idx" ON "quarterly_review_confirmation"("review_id", "status", "confirmed_at");

-- CreateIndex
CREATE UNIQUE INDEX "export_artifact_job_id_key" ON "export_artifact"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "export_artifact_stored_name_key" ON "export_artifact"("stored_name");

-- CreateIndex
CREATE INDEX "export_artifact_review_id_status_created_at_idx" ON "export_artifact"("review_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "export_artifact_status_created_at_idx" ON "export_artifact"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "export_artifact_review_id_input_snapshot_hash_format_template_version_key" ON "export_artifact"("review_id", "input_snapshot_hash", "format", "template_version");

-- 关键状态和不可变快照在数据库层继续收口，不能依赖单个 API 调用方自觉校验。
CREATE TRIGGER "quarterly_review_validate_insert" BEFORE INSERT ON "quarterly_review" BEGIN SELECT CASE WHEN NEW."timezone" <> 'Asia/Shanghai' OR NEW."period_start" > NEW."period_end" OR NEW."next_period_start" <= NEW."period_end" OR NEW."status" NOT IN ('draft','collecting','candidates_ready','selecting','scoring','narrative_ready','confirmed','exported','collection_failed','generation_failed','export_failed') OR NEW."version" < 1 OR (NEW."natural_quarter" = 1 AND (NEW."year" IS NULL OR NEW."quarter" NOT BETWEEN 1 AND 4)) OR (NEW."natural_quarter" = 0 AND (NEW."year" IS NOT NULL OR NEW."quarter" IS NOT NULL)) THEN RAISE(ABORT, 'quarterly_review values are invalid') END; END;
CREATE TRIGGER "quarterly_review_validate_update" BEFORE UPDATE ON "quarterly_review" BEGIN SELECT CASE WHEN NEW."owner_profile_id" <> OLD."owner_profile_id" OR NEW."name" <> OLD."name" OR NEW."period_start" <> OLD."period_start" OR NEW."period_end" <> OLD."period_end" OR NEW."next_period_start" <> OLD."next_period_start" OR NEW."timezone" <> OLD."timezone" OR NEW."natural_quarter" <> OLD."natural_quarter" OR COALESCE(NEW."year", -1) <> COALESCE(OLD."year", -1) OR COALESCE(NEW."quarter", -1) <> COALESCE(OLD."quarter", -1) OR NEW."status" NOT IN ('draft','collecting','candidates_ready','selecting','scoring','narrative_ready','confirmed','exported','collection_failed','generation_failed','export_failed') OR NEW."version" <= OLD."version" THEN RAISE(ABORT, 'quarterly_review transition is invalid') END; END;
CREATE TRIGGER "quarterly_collection_snapshot_immutable" BEFORE UPDATE ON "quarterly_collection_snapshot" BEGIN SELECT RAISE(ABORT, 'quarterly_collection_snapshot is immutable'); END;
CREATE TRIGGER "achievement_validate_insert" BEFORE INSERT ON "achievement" BEGIN SELECT CASE WHEN NEW."source_type" NOT IN ('collected','manual') OR NEW."selection_status" NOT IN ('candidate','selected','excluded','needs_evidence') OR NEW."evidence_status" NOT IN ('complete','partial','needs_evidence') OR NEW."period_start" > NEW."period_end" OR length(trim(NEW."title")) < 1 OR NEW."version" < 1 OR (NEW."selection_status" = 'excluded' AND length(trim(COALESCE(NEW."exclusion_reason", ''))) < 1) THEN RAISE(ABORT, 'achievement values are invalid') END; END;
CREATE TRIGGER "achievement_validate_update" BEFORE UPDATE ON "achievement" BEGIN SELECT CASE WHEN NEW."review_id" <> OLD."review_id" OR COALESCE(NEW."collection_snapshot_id", '') <> COALESCE(OLD."collection_snapshot_id", '') OR NEW."source_type" <> OLD."source_type" OR NEW."source_key" <> OLD."source_key" OR NEW."selection_status" NOT IN ('candidate','selected','excluded','needs_evidence') OR NEW."evidence_status" NOT IN ('complete','partial','needs_evidence') OR NEW."period_start" > NEW."period_end" OR NEW."version" <= OLD."version" OR (NEW."selection_status" = 'excluded' AND length(trim(COALESCE(NEW."exclusion_reason", ''))) < 1) THEN RAISE(ABORT, 'achievement transition is invalid') END; END;
CREATE TRIGGER "achievement_evidence_immutable" BEFORE UPDATE ON "achievement_evidence" BEGIN SELECT RAISE(ABORT, 'achievement_evidence is immutable'); END;
CREATE TRIGGER "performance_metric_template_version_immutable" BEFORE UPDATE ON "performance_metric_template_version" BEGIN SELECT RAISE(ABORT, 'performance_metric_template_version is immutable'); END;
CREATE TRIGGER "performance_metric_validate_insert" BEFORE INSERT ON "performance_metric" BEGIN SELECT CASE WHEN length(trim(NEW."code")) < 1 OR length(trim(NEW."name")) < 1 OR NEW."weight" < 0 OR NEW."minimum" > NEW."maximum" OR NEW."step" <= 0 OR NEW."sort_order" < 1 THEN RAISE(ABORT, 'performance_metric values are invalid') END; END;
CREATE TRIGGER "performance_metric_immutable" BEFORE UPDATE ON "performance_metric" BEGIN SELECT RAISE(ABORT, 'performance_metric is immutable'); END;
CREATE TRIGGER "achievement_metric_link_immutable" BEFORE UPDATE ON "achievement_metric_link" BEGIN SELECT RAISE(ABORT, 'achievement_metric_link is immutable'); END;
CREATE TRIGGER "score_item_validate_insert" BEFORE INSERT ON "score_item" BEGIN SELECT CASE WHEN NEW."validation_status" NOT IN ('missing','valid','invalid') OR NEW."version" < 1 OR (NEW."user_score" IS NOT NULL AND length(trim(COALESCE(NEW."user_reason", ''))) < 1) THEN RAISE(ABORT, 'score_item values are invalid') END; END;
CREATE TRIGGER "score_item_validate_update" BEFORE UPDATE ON "score_item" BEGIN SELECT CASE WHEN NEW."review_id" <> OLD."review_id" OR NEW."metric_id" <> OLD."metric_id" OR NEW."validation_status" NOT IN ('missing','valid','invalid') OR NEW."version" <= OLD."version" OR (NEW."user_score" IS NOT NULL AND length(trim(COALESCE(NEW."user_reason", ''))) < 1) THEN RAISE(ABORT, 'score_item transition is invalid') END; END;
CREATE TRIGGER "review_narrative_version_immutable" BEFORE UPDATE ON "review_narrative_version" BEGIN SELECT RAISE(ABORT, 'review_narrative_version is immutable'); END;
CREATE TRIGGER "quarterly_confirmation_validate_insert" BEFORE INSERT ON "quarterly_review_confirmation" BEGIN SELECT CASE WHEN NEW."status" <> 'active' OR length(NEW."snapshot_hash") <> 64 OR length(NEW."achievements_hash") <> 64 OR length(NEW."scores_hash") <> 64 THEN RAISE(ABORT, 'quarterly_review_confirmation values are invalid') END; END;
CREATE TRIGGER "quarterly_confirmation_validate_update" BEFORE UPDATE ON "quarterly_review_confirmation" BEGIN SELECT CASE WHEN OLD."status" <> 'active' OR NEW."status" <> 'invalidated' OR NEW."invalidated_at" IS NULL OR length(trim(COALESCE(NEW."invalidation_reason", ''))) < 1 OR NEW."snapshot_hash" <> OLD."snapshot_hash" OR NEW."achievements_hash" <> OLD."achievements_hash" OR NEW."scores_hash" <> OLD."scores_hash" OR NEW."calculation_json" <> OLD."calculation_json" THEN RAISE(ABORT, 'quarterly_review_confirmation transition is invalid') END; END;
CREATE TRIGGER "export_artifact_validate_insert" BEFORE INSERT ON "export_artifact" BEGIN SELECT CASE WHEN NEW."format" NOT IN ('xlsx','docx') OR NEW."status" NOT IN ('queued','running','succeeded','failed') OR length(NEW."input_snapshot_hash") <> 64 THEN RAISE(ABORT, 'export_artifact values are invalid') END; END;
CREATE TRIGGER "export_artifact_validate_update" BEFORE UPDATE ON "export_artifact" BEGIN SELECT CASE WHEN NEW."review_id" <> OLD."review_id" OR NEW."confirmation_id" <> OLD."confirmation_id" OR NEW."format" <> OLD."format" OR NEW."template_version" <> OLD."template_version" OR NEW."input_snapshot_hash" <> OLD."input_snapshot_hash" OR OLD."status" IN ('succeeded','failed') OR NEW."status" NOT IN ('running','succeeded','failed') OR (NEW."status" = 'succeeded' AND (NEW."file_name" IS NULL OR NEW."stored_name" IS NULL OR length(COALESCE(NEW."content_hash", '')) <> 64 OR NEW."size_bytes" <= 0)) OR (NEW."status" = 'failed' AND length(trim(COALESCE(NEW."error_code", ''))) < 1) THEN RAISE(ABORT, 'export_artifact transition is invalid') END; END;
