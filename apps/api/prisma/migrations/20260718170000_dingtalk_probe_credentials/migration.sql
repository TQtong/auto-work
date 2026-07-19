-- 钉钉机器人新凭证必须先显式发送测试消息；测试成功后才替换当前凭证，避免错误轮换导致通知通道不可恢复。
ALTER TABLE "integration_connection" ADD COLUMN "pending_credential_ref" TEXT;
ALTER TABLE "integration_connection" ADD COLUMN "pending_credential_mask" TEXT;
ALTER TABLE "integration_connection" ADD COLUMN "pending_credential_created_at" DATETIME;

CREATE TRIGGER "integration_pending_credential_consistency_insert" BEFORE INSERT ON "integration_connection" BEGIN SELECT CASE WHEN (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_mask" IS NULL) OR (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_created_at" IS NULL) THEN RAISE(ABORT, 'pending integration credential fields must be changed together') END; END;

CREATE TRIGGER "integration_pending_credential_consistency_update" BEFORE UPDATE ON "integration_connection" BEGIN SELECT CASE WHEN (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_mask" IS NULL) OR (NEW."pending_credential_ref" IS NULL) <> (NEW."pending_credential_created_at" IS NULL) THEN RAISE(ABORT, 'pending integration credential fields must be changed together') END; END;
