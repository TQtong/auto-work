ALTER TABLE "delivery_intent" ADD COLUMN "scheduled_for" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "delivery_intent" ADD COLUMN "schedule_approved_at" DATETIME;
ALTER TABLE "delivery_intent" ADD COLUMN "schedule_approval_hash" TEXT;
ALTER TABLE "delivery_intent" ADD COLUMN "cancelled_at" DATETIME;
ALTER TABLE "delivery_intent" ADD COLUMN "cancellation_reason" TEXT;

UPDATE "delivery_intent" SET "scheduled_for" = "created_at";

CREATE INDEX "delivery_intent_status_scheduled_for_idx"
  ON "delivery_intent"("status", "scheduled_for");

DROP TRIGGER IF EXISTS "delivery_intent_validate_insert";
DROP TRIGGER IF EXISTS "delivery_intent_validate_update";

CREATE TRIGGER "delivery_intent_validate_insert" BEFORE INSERT ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review','cancelled') OR NEW."recovery_status" NOT IN ('not_required','pending','not_found','absence_confirmed','matched','ambiguous','manual_succeeded','manual_absence_confirmed') OR NEW."attempt_count" < 0 OR NEW."version" < 1 OR NEW."scheduled_for" IS NULL OR (NEW."status" = 'cancelled' AND (NEW."cancelled_at" IS NULL OR length(COALESCE(NEW."cancellation_reason", '')) < 1)) THEN RAISE(ABORT, 'delivery_intent values are invalid') END; END;

CREATE TRIGGER "delivery_intent_validate_update" BEFORE UPDATE ON "delivery_intent" BEGIN SELECT CASE WHEN NEW."channel" NOT IN ('dingtalk_log','dingtalk_robot') OR NEW."status" NOT IN ('pending','running','succeeded','failed','unknown','needs_review','cancelled') OR NEW."recovery_status" NOT IN ('not_required','pending','not_found','absence_confirmed','matched','ambiguous','manual_succeeded','manual_absence_confirmed') OR NEW."attempt_count" < OLD."attempt_count" OR NEW."version" <= OLD."version" OR NEW."scheduled_for" <> OLD."scheduled_for" OR COALESCE(NEW."schedule_approval_hash", '') <> COALESCE(OLD."schedule_approval_hash", '') OR (OLD."status" IN ('succeeded','cancelled') AND NEW."status" <> OLD."status") OR (NEW."status" = 'cancelled' AND OLD."status" <> 'pending') OR (NEW."status" = 'cancelled' AND (NEW."cancelled_at" IS NULL OR length(COALESCE(NEW."cancellation_reason", '')) < 1)) OR (OLD."external_id" IS NOT NULL AND NEW."external_id" <> OLD."external_id") THEN RAISE(ABORT, 'delivery_intent transition is invalid') END; END;
