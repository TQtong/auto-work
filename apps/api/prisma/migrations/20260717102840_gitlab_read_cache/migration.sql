-- AddColumn
ALTER TABLE "repository" ADD COLUMN "remote_port" INTEGER;
ALTER TABLE "repository" ADD COLUMN "gitlab_connection_id" TEXT;

-- CreateTable
CREATE TABLE "gitlab_project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connection_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "path_with_namespace" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "web_url" TEXT NOT NULL,
    "default_branch" TEXT,
    "visibility" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "last_activity_at" DATETIME,
    "namespace_json" TEXT NOT NULL DEFAULT '{}',
    "last_seen_run_id" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "sync_status" TEXT NOT NULL DEFAULT 'unknown',
    "sync_error" TEXT,
    "synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_project_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_project_archived_check" CHECK ("archived" IN (0, 1)),
    CONSTRAINT "gitlab_project_stale_check" CHECK ("stale" IN (0, 1)),
    CONSTRAINT "gitlab_project_visibility_check" CHECK ("visibility" IN ('unknown', 'private', 'internal', 'public')),
    CONSTRAINT "gitlab_project_sync_status_check" CHECK ("sync_status" IN ('unknown', 'refreshing', 'fresh', 'error'))
);

-- CreateTable
CREATE TABLE "gitlab_branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "default_branch" BOOLEAN NOT NULL DEFAULT false,
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "web_url" TEXT,
    "last_seen_run_id" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_branch_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_branch_protected_check" CHECK ("protected" IN (0, 1)),
    CONSTRAINT "gitlab_branch_default_check" CHECK ("default_branch" IN (0, 1)),
    CONSTRAINT "gitlab_branch_merged_check" CHECK ("merged" IN (0, 1)),
    CONSTRAINT "gitlab_branch_stale_check" CHECK ("stale" IN (0, 1))
);

-- CreateTable
CREATE TABLE "gitlab_commit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "short_sha" TEXT,
    "title" TEXT NOT NULL,
    "message_summary" TEXT,
    "author_name" TEXT NOT NULL,
    "author_email" TEXT NOT NULL,
    "committer_name" TEXT,
    "committer_email" TEXT,
    "authored_at" DATETIME,
    "committed_at" DATETIME NOT NULL,
    "web_url" TEXT,
    "last_seen_run_id" TEXT NOT NULL,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_commit_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "gitlab_merge_request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "iid" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "source_branch" TEXT NOT NULL,
    "target_branch" TEXT NOT NULL,
    "author_json" TEXT NOT NULL DEFAULT '{}',
    "assignees_json" TEXT NOT NULL DEFAULT '[]',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "merged_at" DATETIME,
    "closed_at" DATETIME,
    "updated_external_at" DATETIME NOT NULL,
    "web_url" TEXT NOT NULL,
    "last_seen_run_id" TEXT NOT NULL,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_merge_request_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_merge_request_iid_check" CHECK ("iid" >= 0),
    CONSTRAINT "gitlab_merge_request_draft_check" CHECK ("draft" IN (0, 1))
);

-- CreateTable
CREATE TABLE "gitlab_pipeline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "iid" INTEGER,
    "sha" TEXT NOT NULL,
    "ref" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "web_url" TEXT,
    "created_external_at" DATETIME,
    "updated_external_at" DATETIME,
    "last_seen_run_id" TEXT NOT NULL,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_pipeline_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "gitlab_tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_sha" TEXT NOT NULL,
    "message_summary" TEXT,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "web_url" TEXT,
    "created_external_at" DATETIME,
    "last_seen_run_id" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_tag_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_tag_protected_check" CHECK ("protected" IN (0, 1)),
    CONSTRAINT "gitlab_tag_stale_check" CHECK ("stale" IN (0, 1))
);

-- CreateTable
CREATE TABLE "gitlab_release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "tag_name" TEXT NOT NULL,
    "name" TEXT,
    "description_summary" TEXT,
    "released_at" DATETIME,
    "created_external_at" DATETIME,
    "upcoming_release" BOOLEAN NOT NULL DEFAULT false,
    "web_url" TEXT,
    "assets_json" TEXT NOT NULL DEFAULT '{}',
    "last_seen_run_id" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_release_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_release_upcoming_check" CHECK ("upcoming_release" IN (0, 1)),
    CONSTRAINT "gitlab_release_stale_check" CHECK ("stale" IN (0, 1))
);

-- CreateTable
CREATE TABLE "gitlab_project_member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gitlab_project_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "access_level" INTEGER NOT NULL,
    "web_url" TEXT,
    "avatar_url" TEXT,
    "expires_at" DATETIME,
    "last_seen_run_id" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" DATETIME NOT NULL,
    CONSTRAINT "gitlab_project_member_gitlab_project_id_fkey" FOREIGN KEY ("gitlab_project_id") REFERENCES "gitlab_project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_project_member_access_level_check" CHECK ("access_level" >= 0 AND "access_level" <= 100),
    CONSTRAINT "gitlab_project_member_stale_check" CHECK ("stale" IN (0, 1))
);

-- CreateTable
CREATE TABLE "gitlab_sync_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connection_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scope_json" TEXT NOT NULL,
    "counts_json" TEXT NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "error_summary" TEXT,
    "started_at" DATETIME NOT NULL,
    "completed_at" DATETIME,
    CONSTRAINT "gitlab_sync_run_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "gitlab_sync_run_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed'))
);

-- CreateIndex
CREATE INDEX "gitlab_project_connection_id_path_with_namespace_idx" ON "gitlab_project"("connection_id", "path_with_namespace");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_project_connection_id_external_id_key" ON "gitlab_project"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "gitlab_branch_gitlab_project_id_stale_idx" ON "gitlab_branch"("gitlab_project_id", "stale");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_branch_gitlab_project_id_name_key" ON "gitlab_branch"("gitlab_project_id", "name");

-- CreateIndex
CREATE INDEX "gitlab_commit_gitlab_project_id_committed_at_idx" ON "gitlab_commit"("gitlab_project_id", "committed_at");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_commit_gitlab_project_id_sha_key" ON "gitlab_commit"("gitlab_project_id", "sha");

-- CreateIndex
CREATE INDEX "gitlab_merge_request_gitlab_project_id_state_updated_external_at_idx" ON "gitlab_merge_request"("gitlab_project_id", "state", "updated_external_at");

-- CreateIndex
CREATE INDEX "gitlab_merge_request_gitlab_project_id_source_branch_idx" ON "gitlab_merge_request"("gitlab_project_id", "source_branch");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_merge_request_gitlab_project_id_external_id_key" ON "gitlab_merge_request"("gitlab_project_id", "external_id");

-- CreateIndex
CREATE INDEX "gitlab_pipeline_gitlab_project_id_updated_external_at_idx" ON "gitlab_pipeline"("gitlab_project_id", "updated_external_at");

-- CreateIndex
CREATE INDEX "gitlab_pipeline_gitlab_project_id_sha_idx" ON "gitlab_pipeline"("gitlab_project_id", "sha");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_pipeline_gitlab_project_id_external_id_key" ON "gitlab_pipeline"("gitlab_project_id", "external_id");

-- CreateIndex
CREATE INDEX "gitlab_tag_gitlab_project_id_stale_idx" ON "gitlab_tag"("gitlab_project_id", "stale");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_tag_gitlab_project_id_name_key" ON "gitlab_tag"("gitlab_project_id", "name");

-- CreateIndex
CREATE INDEX "gitlab_release_gitlab_project_id_stale_idx" ON "gitlab_release"("gitlab_project_id", "stale");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_release_gitlab_project_id_tag_name_key" ON "gitlab_release"("gitlab_project_id", "tag_name");

-- CreateIndex
CREATE INDEX "gitlab_project_member_gitlab_project_id_stale_idx" ON "gitlab_project_member"("gitlab_project_id", "stale");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_project_member_gitlab_project_id_external_user_id_key" ON "gitlab_project_member"("gitlab_project_id", "external_user_id");

-- CreateIndex
CREATE INDEX "gitlab_sync_run_connection_id_started_at_idx" ON "gitlab_sync_run"("connection_id", "started_at");

-- CreateIndex
CREATE INDEX "repository_gitlab_connection_id_gitlab_project_ref_idx" ON "repository"("gitlab_connection_id", "gitlab_project_ref");
