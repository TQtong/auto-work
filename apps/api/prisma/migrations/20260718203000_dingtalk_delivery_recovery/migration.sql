-- 恢复字段只记录核对状态和人工裁决元数据，六字段正文仍只存在于冻结的周报版本中。
ALTER TABLE "delivery_intent" ADD COLUMN "recovery_status" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "delivery_intent" ADD COLUMN "last_recovery_at" DATETIME;
ALTER TABLE "delivery_intent" ADD COLUMN "resolved_by" TEXT;
ALTER TABLE "delivery_intent" ADD COLUMN "resolved_at" DATETIME;
ALTER TABLE "delivery_intent" ADD COLUMN "resolution_reason" TEXT;

CREATE TABLE "delivery_recovery_check" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "intent_id" TEXT NOT NULL,
  "sequence_no" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "query_window_start" DATETIME,
  "query_window_end" DATETIME,
  "candidate_count" INTEGER NOT NULL DEFAULT 0,
  "exact_match_count" INTEGER NOT NULL DEFAULT 0,
  "matched_external_id" TEXT,
  "evidence_hash" TEXT NOT NULL,
  "summary_json" TEXT NOT NULL DEFAULT '{}',
  "actor_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_recovery_check_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "delivery_intent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "delivery_recovery_check_intent_id_sequence_no_key" ON "delivery_recovery_check"("intent_id", "sequence_no");
CREATE INDEX "delivery_recovery_check_intent_id_created_at_idx" ON "delivery_recovery_check"("intent_id", "created_at");

DROP TRIGGER "delivery_intent_validate_insert";
DROP TRIGGER "delivery_intent_validate_update";
CREATE TRIGGER "delivery_intent_validate_insert" BEFORE INSERT ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review') OR NEW."recovery_status" NOT IN ('not_required','pending','not_found','absence_confirmed','matched','ambiguous','manual_succeeded','manual_absence_confirmed') OR NEW."attempt_count" < 0 OR NEW."version" < 1 THEN RAISE(ABORT, 'delivery_intent values are invalid') END; END;
CREATE TRIGGER "delivery_intent_validate_update" BEFORE UPDATE ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review') OR NEW."recovery_status" NOT IN ('not_required','pending','not_found','absence_confirmed','matched','ambiguous','manual_succeeded','manual_absence_confirmed') OR NEW."attempt_count" < OLD."attempt_count" OR NEW."version" <= OLD."version" OR OLD."status" = 'succeeded' AND NEW."status" <> 'succeeded' OR OLD."external_id" IS NOT NULL AND NEW."external_id" <> OLD."external_id" THEN RAISE(ABORT, 'delivery_intent transition is invalid') END; END;
CREATE TRIGGER "delivery_recovery_check_validate_insert" BEFORE INSERT ON "delivery_recovery_check" BEGIN SELECT CASE WHEN NEW."sequence_no" < 1 OR NEW."mode" NOT IN ('provider_query','manual_resolution') OR NEW."outcome" NOT IN ('matched','not_found','absence_confirmed','ambiguous','query_failed','manual_succeeded','manual_absence_confirmed') OR NEW."candidate_count" < 0 OR NEW."exact_match_count" < 0 OR NEW."exact_match_count" > NEW."candidate_count" THEN RAISE(ABORT, 'delivery_recovery_check values are invalid') END; END;
CREATE TRIGGER "delivery_recovery_check_immutable" BEFORE UPDATE ON "delivery_recovery_check" BEGIN SELECT RAISE(ABORT, 'delivery_recovery_check is immutable'); END;
