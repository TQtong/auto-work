-- 导出是可安全重放的后台作业；失败或取消后复用同一确认/格式制品记录并递增尝试次数。
ALTER TABLE "export_artifact" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "export_artifact" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "export_artifact" ADD COLUMN "qa_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "export_artifact" ADD COLUMN "qa_report_json" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "export_artifact" ADD COLUMN "renderer_facts_json" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "export_artifact" ADD COLUMN "started_at" DATETIME;
ALTER TABLE "export_artifact" ADD COLUMN "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "quarterly_review_confirmation" ADD COLUMN "review_snapshot_json" TEXT NOT NULL DEFAULT '{}';
UPDATE "quarterly_review_confirmation"
SET "review_snapshot_json" = (
  SELECT json_object(
    'id', review."id",
    'name', review."name",
    'periodStart', review."period_start",
    'periodEnd', review."period_end",
    'timezone', review."timezone",
    'version', "quarterly_review_confirmation"."review_version"
  )
  FROM "quarterly_review" AS review
  WHERE review."id" = "quarterly_review_confirmation"."review_id"
);

DROP TRIGGER "export_artifact_validate_insert";
DROP TRIGGER "export_artifact_validate_update";

CREATE TRIGGER "export_artifact_validate_insert" BEFORE INSERT ON "export_artifact" BEGIN SELECT CASE WHEN NEW."format" NOT IN ('xlsx','docx') OR NEW."status" <> 'queued' OR NEW."qa_status" <> 'pending' OR NEW."attempt_count" <> 0 OR NEW."version" < 1 OR length(NEW."input_snapshot_hash") <> 64 OR json_valid(NEW."qa_report_json") <> 1 OR json_valid(NEW."renderer_facts_json") <> 1 OR NEW."job_id" IS NULL THEN RAISE(ABORT, 'export_artifact values are invalid') END; END;

CREATE TRIGGER "export_artifact_validate_update" BEFORE UPDATE ON "export_artifact" BEGIN SELECT CASE WHEN NEW."review_id" <> OLD."review_id" OR NEW."confirmation_id" <> OLD."confirmation_id" OR NEW."format" <> OLD."format" OR NEW."template_version" <> OLD."template_version" OR NEW."input_snapshot_hash" <> OLD."input_snapshot_hash" OR NEW."created_by" <> OLD."created_by" OR NEW."created_at" <> OLD."created_at" OR NEW."version" <= OLD."version" OR NEW."attempt_count" < OLD."attempt_count" OR NEW."status" NOT IN ('queued','running','succeeded','failed','cancelled') OR NEW."qa_status" NOT IN ('pending','passed','failed') OR json_valid(NEW."qa_report_json") <> 1 OR json_valid(NEW."renderer_facts_json") <> 1 OR (OLD."status" = 'queued' AND NEW."status" NOT IN ('running','cancelled')) OR (OLD."status" = 'running' AND NEW."status" NOT IN ('succeeded','failed','cancelled')) OR (OLD."status" IN ('failed','cancelled') AND (NEW."status" <> 'queued' OR NEW."attempt_count" <= OLD."attempt_count" OR NEW."job_id" = OLD."job_id")) OR (OLD."status" = 'succeeded') OR (NEW."status" = 'queued' AND (NEW."qa_status" <> 'pending' OR NEW."started_at" IS NOT NULL OR NEW."completed_at" IS NOT NULL OR NEW."file_name" IS NOT NULL OR NEW."stored_name" IS NOT NULL OR NEW."mime_type" IS NOT NULL OR NEW."content_hash" IS NOT NULL OR NEW."size_bytes" IS NOT NULL OR NEW."error_code" IS NOT NULL)) OR (NEW."status" = 'running' AND NEW."started_at" IS NULL) OR (NEW."status" = 'succeeded' AND (NEW."completed_at" IS NULL OR NEW."file_name" IS NULL OR NEW."stored_name" IS NULL OR length(COALESCE(NEW."content_hash", '')) <> 64 OR NEW."size_bytes" <= 0 OR NEW."qa_status" <> 'passed')) OR (NEW."status" = 'failed' AND (NEW."completed_at" IS NULL OR length(trim(COALESCE(NEW."error_code", ''))) < 1 OR NEW."qa_status" <> 'failed')) OR (NEW."status" = 'cancelled' AND (NEW."completed_at" IS NULL OR length(trim(COALESCE(NEW."error_code", ''))) < 1)) THEN RAISE(ABORT, 'export_artifact transition is invalid') END; END;
