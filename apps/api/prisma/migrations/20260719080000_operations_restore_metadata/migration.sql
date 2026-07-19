-- 恢复兼容性不能只比较应用声称的版本；备份必须冻结实际已部署 schema 身份。
INSERT INTO "schema_metadata" ("id", "application_version", "schema_checksum", "updated_at")
VALUES (1, '0.1.0', '20260719080000_operations_restore_metadata', CURRENT_TIMESTAMP)
ON CONFLICT("id") DO UPDATE SET
  "application_version" = excluded."application_version",
  "schema_checksum" = excluded."schema_checksum",
  "updated_at" = CURRENT_TIMESTAMP;
