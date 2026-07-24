PRAGMA foreign_keys=OFF;

CREATE TABLE "new_integration_connection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL CHECK ("type" IN ('gitlab', 'jira', 'dingtalk_log', 'dingtalk_desktop', 'dingtalk_robot', 'ai')),
  "name" TEXT NOT NULL,
  "base_url" TEXT,
  "credential_ref" TEXT,
  "credential_mask" TEXT,
  "pending_credential_ref" TEXT,
  "pending_credential_mask" TEXT,
  "pending_credential_created_at" DATETIME,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'unknown' CHECK ("status" IN ('unknown', 'testing', 'healthy', 'degraded', 'invalid', 'disabled', 'configuration_required', 'mapping_invalid')),
  "capabilities_json" TEXT NOT NULL DEFAULT '{}',
  "config_json" TEXT NOT NULL DEFAULT '{}',
  "last_tested_at" DATETIME,
  "last_success_at" DATETIME,
  "disabled_at" DATETIME,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

INSERT INTO "new_integration_connection" (
  "id", "type", "name", "base_url", "credential_ref", "credential_mask",
  "pending_credential_ref", "pending_credential_mask", "pending_credential_created_at",
  "enabled", "status", "capabilities_json", "config_json", "last_tested_at",
  "last_success_at", "disabled_at", "version", "created_at", "updated_at"
) SELECT
  "id", "type", "name", "base_url", "credential_ref", "credential_mask",
  "pending_credential_ref", "pending_credential_mask", "pending_credential_created_at",
  "enabled", "status", "capabilities_json", "config_json", "last_tested_at",
  "last_success_at", "disabled_at", "version", "created_at", "updated_at"
FROM "integration_connection";

DROP TABLE "integration_connection";
ALTER TABLE "new_integration_connection" RENAME TO "integration_connection";
CREATE INDEX "integration_connection_type_enabled_status_idx" ON "integration_connection"("type", "enabled", "status");

CREATE TRIGGER "integration_pending_credential_consistency_insert" BEFORE INSERT ON "integration_connection" BEGIN SELECT CASE WHEN (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_mask" IS NULL) OR (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_created_at" IS NULL) THEN RAISE(ABORT, 'pending integration credential fields must be changed together') END; END;

CREATE TRIGGER "integration_pending_credential_consistency_update" BEFORE UPDATE ON "integration_connection" BEGIN SELECT CASE WHEN (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_mask" IS NULL) OR (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_created_at" IS NULL) THEN RAISE(ABORT, 'pending integration credential fields must be changed together') END; END;

PRAGMA foreign_keys=ON;
