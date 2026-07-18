-- 版本必须同时冻结模板映射与计划提交时间；迁移旧数据时暂时移除不可变触发器，回填后立即恢复。
DROP TRIGGER "weekly_report_version_immutable_update";
ALTER TABLE "weekly_report_version" ADD COLUMN "template_mapping_version_id" TEXT;
ALTER TABLE "weekly_report_version" ADD COLUMN "schedule_at" DATETIME;
UPDATE "weekly_report_version"
SET "template_mapping_version_id" = (SELECT "template_mapping_version_id" FROM "weekly_report" WHERE "weekly_report"."id" = "weekly_report_version"."report_id"),
    "schedule_at" = (SELECT "schedule_at" FROM "weekly_report" WHERE "weekly_report"."id" = "weekly_report_version"."report_id");
CREATE TRIGGER "weekly_report_version_immutable_update" BEFORE UPDATE ON "weekly_report_version" BEGIN SELECT RAISE(ABORT, 'weekly_report_version is immutable'); END;

CREATE TABLE "dingtalk_template_mapping" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connection_id" TEXT NOT NULL,
  "current_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "dingtalk_template_mapping_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dingtalk_template_mapping_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "dingtalk_template_mapping_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dingtalk_template_mapping_version_check" CHECK ("version" > 0)
);

CREATE TABLE "dingtalk_template_mapping_version" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mapping_id" TEXT NOT NULL,
  "version_no" INTEGER NOT NULL,
  "template_id" TEXT NOT NULL,
  "template_name" TEXT NOT NULL,
  "external_template_version" TEXT,
  "template_hash" TEXT NOT NULL,
  "fields_json" TEXT NOT NULL,
  "capability_snapshot_hash" TEXT NOT NULL,
  "observed_at" DATETIME NOT NULL,
  "expires_at" DATETIME NOT NULL,
  "content_hash" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dingtalk_template_mapping_version_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "dingtalk_template_mapping" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dingtalk_template_mapping_version_no_check" CHECK ("version_no" > 0),
  CONSTRAINT "dingtalk_template_mapping_version_expiry_check" CHECK ("expires_at" > "observed_at")
);

CREATE TABLE "dingtalk_recipient_validation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connection_id" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "available" BOOLEAN NOT NULL,
  "capability_snapshot_hash" TEXT NOT NULL,
  "observed_at" DATETIME NOT NULL,
  "expires_at" DATETIME NOT NULL,
  "content_hash" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dingtalk_recipient_validation_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dingtalk_recipient_validation_type_check" CHECK ("subject_type" IN ('user', 'department', 'group')),
  CONSTRAINT "dingtalk_recipient_validation_expiry_check" CHECK ("expires_at" > "observed_at")
);

CREATE TABLE "weekly_report_attachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "stored_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "content_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'available',
  "created_by" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" DATETIME,
  CONSTRAINT "weekly_report_attachment_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_attachment_size_check" CHECK ("size_bytes" > 0),
  CONSTRAINT "weekly_report_attachment_status_check" CHECK ("status" IN ('available', 'deleted')),
  CONSTRAINT "weekly_report_attachment_deleted_check" CHECK (("status" = 'available' AND "deleted_at" IS NULL) OR ("status" = 'deleted' AND "deleted_at" IS NOT NULL))
);

CREATE TABLE "weekly_report_confirmation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT NOT NULL,
  "version_id" TEXT NOT NULL,
  "report_aggregate_version" INTEGER NOT NULL,
  "content_hash" TEXT NOT NULL,
  "template_mapping_version_id" TEXT NOT NULL,
  "warning_acknowledgements_json" TEXT NOT NULL,
  "recipient_scope_hash" TEXT NOT NULL,
  "attachments_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "confirmed_by" TEXT NOT NULL,
  "confirmed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidated_at" DATETIME,
  "invalidation_reason" TEXT,
  CONSTRAINT "weekly_report_confirmation_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "weekly_report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_confirmation_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "weekly_report_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_confirmation_template_mapping_version_id_fkey" FOREIGN KEY ("template_mapping_version_id") REFERENCES "dingtalk_template_mapping_version" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "weekly_report_confirmation_aggregate_version_check" CHECK ("report_aggregate_version" > 0),
  CONSTRAINT "weekly_report_confirmation_status_check" CHECK ("status" IN ('active', 'invalidated')),
  CONSTRAINT "weekly_report_confirmation_invalidation_check" CHECK (("status" = 'active' AND "invalidated_at" IS NULL AND "invalidation_reason" IS NULL) OR ("status" = 'invalidated' AND "invalidated_at" IS NOT NULL AND length(trim("invalidation_reason")) > 0))
);

ALTER TABLE "weekly_report" ADD COLUMN "current_confirmation_id" TEXT REFERENCES "weekly_report_confirmation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "dingtalk_template_mapping_connection_id_key" ON "dingtalk_template_mapping"("connection_id");
CREATE UNIQUE INDEX "dingtalk_template_mapping_current_version_id_key" ON "dingtalk_template_mapping"("current_version_id");
CREATE UNIQUE INDEX "dingtalk_template_mapping_version_mapping_id_version_no_key" ON "dingtalk_template_mapping_version"("mapping_id", "version_no");
CREATE INDEX "dingtalk_template_mapping_version_template_id_observed_at_idx" ON "dingtalk_template_mapping_version"("template_id", "observed_at");
CREATE UNIQUE INDEX "dingtalk_recipient_validation_connection_id_subject_type_external_id_content_hash_key" ON "dingtalk_recipient_validation"("connection_id", "subject_type", "external_id", "content_hash");
CREATE INDEX "dingtalk_recipient_validation_connection_id_subject_type_external_id_observed_at_idx" ON "dingtalk_recipient_validation"("connection_id", "subject_type", "external_id", "observed_at");
CREATE UNIQUE INDEX "weekly_report_attachment_stored_name_key" ON "weekly_report_attachment"("stored_name");
CREATE INDEX "weekly_report_attachment_report_id_status_created_at_idx" ON "weekly_report_attachment"("report_id", "status", "created_at");
CREATE UNIQUE INDEX "weekly_report_confirmation_report_id_version_id_content_hash_template_mapping_version_id_recipient_scope_hash_attachments_hash_key" ON "weekly_report_confirmation"("report_id", "version_id", "content_hash", "template_mapping_version_id", "recipient_scope_hash", "attachments_hash");
CREATE INDEX "weekly_report_confirmation_report_id_status_confirmed_at_idx" ON "weekly_report_confirmation"("report_id", "status", "confirmed_at");
CREATE UNIQUE INDEX "weekly_report_current_confirmation_id_key" ON "weekly_report"("current_confirmation_id");

-- 模板映射版本和收件人校验快照来自外部能力探测，只允许追加，禁止覆盖历史事实。
CREATE TRIGGER "dingtalk_template_mapping_version_immutable_update" BEFORE UPDATE ON "dingtalk_template_mapping_version" BEGIN SELECT RAISE(ABORT, 'dingtalk_template_mapping_version is immutable'); END;
CREATE TRIGGER "dingtalk_recipient_validation_immutable_update" BEFORE UPDATE ON "dingtalk_recipient_validation" BEGIN SELECT RAISE(ABORT, 'dingtalk_recipient_validation is immutable'); END;

-- 附件实体只允许从 available 迁移到 deleted，文件名、哈希、大小等证据字段不得静默改写。
CREATE TRIGGER "weekly_report_attachment_immutable_metadata" BEFORE UPDATE ON "weekly_report_attachment"
WHEN OLD."report_id" IS NOT NEW."report_id"
  OR OLD."original_name" IS NOT NEW."original_name"
  OR OLD."stored_name" IS NOT NEW."stored_name"
  OR OLD."mime_type" IS NOT NEW."mime_type"
  OR OLD."extension" IS NOT NEW."extension"
  OR OLD."size_bytes" IS NOT NEW."size_bytes"
  OR OLD."content_hash" IS NOT NEW."content_hash"
  OR OLD."created_by" IS NOT NEW."created_by"
  OR OLD."created_at" IS NOT NEW."created_at"
BEGIN SELECT RAISE(ABORT, 'weekly_report_attachment metadata is immutable'); END;

-- 确认记录的锁定内容不可变；仅允许追加失效时间与原因，保留曾经确认过什么的完整审计链。
CREATE TRIGGER "weekly_report_confirmation_locked_fields" BEFORE UPDATE ON "weekly_report_confirmation"
WHEN OLD."report_id" IS NOT NEW."report_id"
  OR OLD."version_id" IS NOT NEW."version_id"
  OR OLD."report_aggregate_version" IS NOT NEW."report_aggregate_version"
  OR OLD."content_hash" IS NOT NEW."content_hash"
  OR OLD."template_mapping_version_id" IS NOT NEW."template_mapping_version_id"
  OR OLD."warning_acknowledgements_json" IS NOT NEW."warning_acknowledgements_json"
  OR OLD."recipient_scope_hash" IS NOT NEW."recipient_scope_hash"
  OR OLD."attachments_hash" IS NOT NEW."attachments_hash"
  OR OLD."confirmed_by" IS NOT NEW."confirmed_by"
  OR OLD."confirmed_at" IS NOT NEW."confirmed_at"
BEGIN SELECT RAISE(ABORT, 'weekly_report_confirmation locked fields are immutable'); END;
