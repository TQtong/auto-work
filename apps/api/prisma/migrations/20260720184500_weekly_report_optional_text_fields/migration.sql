-- 周报五个正文栏位允许为空；填写日期仍由应用层和既有字段约束保证。
-- SQLite 无法直接修改触发器，因此重建插入校验并移除 problems_text 非空限制。
DROP TRIGGER IF EXISTS "weekly_report_version_validate_insert";

CREATE TRIGGER "weekly_report_version_validate_insert"
BEFORE INSERT ON "weekly_report_version"
BEGIN
  SELECT CASE
    WHEN NEW."version_no" <= 0
      THEN RAISE(ABORT, 'weekly_report_version version_no must be positive')
    WHEN NEW."origin" NOT IN ('rule', 'ai', 'manual', 'restore')
      THEN RAISE(ABORT, 'weekly_report_version origin is invalid')
    WHEN NEW."origin" = 'ai' AND NEW."ai_generation_id" IS NULL
      THEN RAISE(ABORT, 'ai weekly_report_version requires ai_generation_id')
    WHEN NEW."ai_generation_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "ai_generation"
      WHERE "id" = NEW."ai_generation_id"
        AND "report_id" = NEW."report_id"
        AND "status" = 'succeeded'
    )
      THEN RAISE(ABORT, 'weekly_report_version ai_generation is not usable')
  END; END;
