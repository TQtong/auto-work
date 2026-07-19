ALTER TABLE "task_field_provenance" ADD COLUMN "expires_at" DATETIME;
ALTER TABLE "task_field_provenance" ADD COLUMN "conflict_value_json" TEXT;
ALTER TABLE "task_field_provenance" ADD COLUMN "conflict_detected_at" DATETIME;

CREATE INDEX "task_field_provenance_source_type_active_expires_at_idx"
ON "task_field_provenance"("source_type", "active", "expires_at");

CREATE INDEX "task_field_provenance_active_conflict_detected_at_idx"
ON "task_field_provenance"("active", "conflict_detected_at");
