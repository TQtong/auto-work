-- Prisma 为增加 ai_generation 外键重建了 weekly_report_version，SQLite 会随旧表一并删除触发器。
-- 在独立迁移中恢复不可变性，并用触发器补回 Prisma Schema 无法表达的领域约束。
DROP TRIGGER IF EXISTS "weekly_report_version_immutable_update";

CREATE TRIGGER "weekly_report_version_validate_insert"
BEFORE INSERT ON "weekly_report_version"
BEGIN
  SELECT CASE
    WHEN NEW."version_no" <= 0
      THEN RAISE(ABORT, 'weekly_report_version version_no must be positive')
    WHEN NEW."origin" NOT IN ('rule', 'ai', 'manual', 'restore')
      THEN RAISE(ABORT, 'weekly_report_version origin is invalid')
    WHEN length(trim(NEW."problems_text")) = 0
      THEN RAISE(ABORT, 'weekly_report_version problems_text is required')
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

CREATE TRIGGER "weekly_report_version_immutable_update"
BEFORE UPDATE ON "weekly_report_version"
BEGIN
  SELECT RAISE(ABORT, 'weekly_report_version is immutable'); END;

-- 生成记录在写入时必须已经结束；这样失败和安全阻断同样能以单次不可变事件留痕。
CREATE TRIGGER "ai_generation_validate_insert"
BEFORE INSERT ON "ai_generation"
BEGIN
  SELECT CASE
    WHEN NEW."provider_config_version" <= 0
      THEN RAISE(ABORT, 'ai_generation provider_config_version must be positive')
    WHEN NEW."base_report_version" IS NOT NULL AND NEW."base_report_version" <= 0
      THEN RAISE(ABORT, 'ai_generation base_report_version must be positive')
    WHEN NEW."purpose" NOT IN ('weekly_report', 'evidence_suggestion', 'quarterly_review', 'score_suggestion')
      THEN RAISE(ABORT, 'ai_generation purpose is invalid')
    WHEN NEW."protocol" NOT IN ('openai_compatible', 'anthropic', 'gemini')
      THEN RAISE(ABORT, 'ai_generation protocol is invalid')
    WHEN NEW."status" NOT IN ('succeeded', 'failed', 'blocked')
      THEN RAISE(ABORT, 'ai_generation status is invalid')
    WHEN NEW."retention_mode" NOT IN ('hash_only', 'sanitized_input')
      THEN RAISE(ABORT, 'ai_generation retention_mode is invalid')
    WHEN NEW."retention_mode" = 'hash_only' AND NEW."sanitized_input_json" IS NOT NULL
      THEN RAISE(ABORT, 'hash_only ai_generation cannot retain sanitized input')
    WHEN NEW."duration_ms" IS NOT NULL AND NEW."duration_ms" < 0
      THEN RAISE(ABORT, 'ai_generation duration_ms cannot be negative')
    WHEN json_valid(NEW."requested_fields_json") = 0
      OR json_type(NEW."requested_fields_json") <> 'array'
      OR json_valid(NEW."input_refs_json") = 0
      OR json_type(NEW."input_refs_json") <> 'array'
      OR json_valid(NEW."input_categories_json") = 0
      OR json_type(NEW."input_categories_json") <> 'array'
      OR json_valid(NEW."removed_categories_json") = 0
      OR json_type(NEW."removed_categories_json") <> 'array'
      OR json_valid(NEW."usage_json") = 0
      OR json_type(NEW."usage_json") <> 'object'
      OR json_valid(NEW."security_blocks_json") = 0
      OR json_type(NEW."security_blocks_json") <> 'array'
      THEN RAISE(ABORT, 'ai_generation JSON shape is invalid')
    WHEN NEW."status" = 'succeeded' AND (
      NEW."sanitized_input_hash" IS NULL
      OR NEW."raw_output" IS NULL
      OR NEW."parsed_output_json" IS NULL
      OR json_valid(NEW."parsed_output_json") = 0
      OR NEW."error_code" IS NOT NULL
    )
      THEN RAISE(ABORT, 'succeeded ai_generation is incomplete')
    WHEN NEW."status" = 'failed' AND NEW."error_code" IS NULL
      THEN RAISE(ABORT, 'failed ai_generation requires error_code')
    WHEN NEW."status" = 'blocked' AND json_array_length(NEW."security_blocks_json") = 0
      THEN RAISE(ABORT, 'blocked ai_generation requires security categories')
    WHEN NEW."adoption_status" NOT IN ('pending', 'adopted', 'rejected', 'not_applicable')
      THEN RAISE(ABORT, 'ai_generation adoption_status is invalid')
    WHEN NEW."adoption_status" = 'pending' AND (
      NEW."status" <> 'succeeded'
      OR NEW."purpose" <> 'weekly_report'
      OR NEW."report_id" IS NULL
      OR NEW."base_version_id" IS NULL
      OR NEW."base_report_version" IS NULL
    )
      THEN RAISE(ABORT, 'pending ai_generation is incomplete')
    WHEN NEW."adoption_status" = 'adopted' AND (
      NEW."status" <> 'succeeded' OR NEW."adopted_version_id" IS NULL OR NEW."decided_at" IS NULL
    )
      THEN RAISE(ABORT, 'adopted ai_generation is incomplete')
    WHEN NEW."adoption_status" IN ('pending', 'not_applicable', 'rejected')
      AND NEW."adopted_version_id" IS NOT NULL
      THEN RAISE(ABORT, 'non-adopted ai_generation cannot reference adopted version')
    WHEN NEW."report_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "weekly_report"
      WHERE "id" = NEW."report_id" AND "owner_profile_id" = NEW."owner_profile_id"
    )
      THEN RAISE(ABORT, 'ai_generation report owner mismatch')
    WHEN NEW."base_version_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "weekly_report_version"
      WHERE "id" = NEW."base_version_id" AND "report_id" = NEW."report_id"
    )
      THEN RAISE(ABORT, 'ai_generation base version mismatch')
  END; END;

-- 除人工采纳决定外，生成事实永不可修改；决定只能从 pending 单向进入 adopted/rejected。
CREATE TRIGGER "ai_generation_immutable_update"
BEFORE UPDATE ON "ai_generation"
BEGIN
  SELECT CASE WHEN
    NEW."id" IS NOT OLD."id"
    OR NEW."owner_profile_id" IS NOT OLD."owner_profile_id"
    OR NEW."provider_connection_id" IS NOT OLD."provider_connection_id"
    OR NEW."provider_config_version" IS NOT OLD."provider_config_version"
    OR NEW."report_id" IS NOT OLD."report_id"
    OR NEW."base_version_id" IS NOT OLD."base_version_id"
    OR NEW."base_report_version" IS NOT OLD."base_report_version"
    OR NEW."purpose" IS NOT OLD."purpose"
    OR NEW."prompt_template_version" IS NOT OLD."prompt_template_version"
    OR NEW."sanitization_policy_version" IS NOT OLD."sanitization_policy_version"
    OR NEW."retention_mode" IS NOT OLD."retention_mode"
    OR NEW."requested_fields_json" IS NOT OLD."requested_fields_json"
    OR NEW."input_refs_json" IS NOT OLD."input_refs_json"
    OR NEW."input_categories_json" IS NOT OLD."input_categories_json"
    OR NEW."removed_categories_json" IS NOT OLD."removed_categories_json"
    OR NEW."sanitized_input_hash" IS NOT OLD."sanitized_input_hash"
    OR NEW."sanitized_input_json" IS NOT OLD."sanitized_input_json"
    OR NEW."raw_output" IS NOT OLD."raw_output"
    OR NEW."parsed_output_json" IS NOT OLD."parsed_output_json"
    OR NEW."protocol" IS NOT OLD."protocol"
    OR NEW."model" IS NOT OLD."model"
    OR NEW."provider_request_id" IS NOT OLD."provider_request_id"
    OR NEW."stop_reason" IS NOT OLD."stop_reason"
    OR NEW."usage_json" IS NOT OLD."usage_json"
    OR NEW."duration_ms" IS NOT OLD."duration_ms"
    OR NEW."status" IS NOT OLD."status"
    OR NEW."error_code" IS NOT OLD."error_code"
    OR NEW."security_blocks_json" IS NOT OLD."security_blocks_json"
    OR NEW."created_by" IS NOT OLD."created_by"
    OR NEW."created_at" IS NOT OLD."created_at"
    OR NEW."completed_at" IS NOT OLD."completed_at"
    THEN RAISE(ABORT, 'ai_generation facts are immutable') END; SELECT CASE
    WHEN OLD."adoption_status" <> 'pending'
      THEN RAISE(ABORT, 'ai_generation adoption decision is final')
    WHEN NEW."adoption_status" NOT IN ('adopted', 'rejected')
      THEN RAISE(ABORT, 'ai_generation adoption transition is invalid')
    WHEN NEW."decided_at" IS NULL
      THEN RAISE(ABORT, 'ai_generation decision requires decided_at')
    WHEN NEW."adoption_status" = 'adopted' AND (
      NEW."adopted_version_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "weekly_report_version"
        WHERE "id" = NEW."adopted_version_id"
          AND "report_id" = NEW."report_id"
          AND "ai_generation_id" = NEW."id"
      )
    )
      THEN RAISE(ABORT, 'adopted version does not derive from ai_generation')
    WHEN NEW."adoption_status" = 'rejected' AND NEW."adopted_version_id" IS NOT NULL
      THEN RAISE(ABORT, 'rejected ai_generation cannot reference adopted version')
  END; END;
