ALTER TABLE "achievement_metric_link" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "achievement_metric_link" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "achievement_metric_link" ADD COLUMN "superseded_at" DATETIME;

DROP INDEX "achievement_metric_link_achievement_id_metric_id_key";
CREATE UNIQUE INDEX "achievement_metric_link_achievement_id_metric_id_version_key" ON "achievement_metric_link"("achievement_id", "metric_id", "version");
CREATE UNIQUE INDEX "achievement_metric_link_one_active_key" ON "achievement_metric_link"("achievement_id", "metric_id") WHERE "active" = true;

-- 历史版本尚未限制主证据数量；升级时确定性保留最早一条，再恢复不可变保护。
DROP TRIGGER "achievement_evidence_immutable";
UPDATE "achievement_evidence" AS current SET "primary_evidence" = false WHERE current."primary_evidence" = true AND EXISTS (SELECT 1 FROM "achievement_evidence" AS earlier WHERE earlier."achievement_id" = current."achievement_id" AND earlier."primary_evidence" = true AND (earlier."created_at" < current."created_at" OR (earlier."created_at" = current."created_at" AND earlier."id" < current."id")));
CREATE UNIQUE INDEX "achievement_evidence_one_primary_key" ON "achievement_evidence"("achievement_id") WHERE "primary_evidence" = true;
CREATE TRIGGER "achievement_evidence_immutable" BEFORE UPDATE ON "achievement_evidence" BEGIN SELECT RAISE(ABORT, 'achievement_evidence is immutable'); END;

DROP TRIGGER "achievement_metric_link_immutable";
CREATE TRIGGER "achievement_metric_link_validate_insert" BEFORE INSERT ON "achievement_metric_link" BEGIN SELECT CASE WHEN NEW."version" < 1 OR length(trim(NEW."contribution")) < 1 OR (NEW."active" = 1 AND NEW."superseded_at" IS NOT NULL) OR (NEW."active" = 0 AND NEW."superseded_at" IS NULL) THEN RAISE(ABORT, 'achievement_metric_link values are invalid') END; END;
CREATE TRIGGER "achievement_metric_link_validate_update" BEFORE UPDATE ON "achievement_metric_link" BEGIN SELECT CASE WHEN OLD."active" <> 1 OR NEW."active" <> 0 OR NEW."superseded_at" IS NULL OR NEW."achievement_id" <> OLD."achievement_id" OR NEW."metric_id" <> OLD."metric_id" OR NEW."version" <> OLD."version" OR NEW."contribution" <> OLD."contribution" THEN RAISE(ABORT, 'achievement_metric_link transition is invalid') END; END;
