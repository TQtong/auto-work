-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "alias" TEXT,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true CHECK ("enabled" IN (0, 1)),
    "sort_order" INTEGER NOT NULL DEFAULT 0 CHECK ("sort_order" >= 0),
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
    "archived_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT,
    "canonical_path" TEXT NOT NULL,
    "real_path_hash" TEXT NOT NULL,
    "identity_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "alias" TEXT,
    "git_dir_kind" TEXT NOT NULL CHECK ("git_dir_kind" IN ('normal', 'worktree')),
    "remote_name" TEXT,
    "remote_url" TEXT,
    "remote_protocol" TEXT,
    "remote_host" TEXT,
    "remote_path" TEXT,
    "gitlab_project_ref" TEXT,
    "baseline_branch" TEXT,
    "whitelist_status" TEXT NOT NULL DEFAULT 'discovered' CHECK ("whitelist_status" IN ('discovered', 'confirmed', 'needs_review', 'disabled', 'missing')),
    "status_reason" TEXT,
    "last_seen_at" DATETIME,
    "last_local_refresh_at" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repository_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "git_snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repository_id" TEXT NOT NULL,
    "head_sha" TEXT,
    "branch_name" TEXT,
    "detached" BOOLEAN NOT NULL DEFAULT false CHECK ("detached" IN (0, 1)),
    "unborn" BOOLEAN NOT NULL DEFAULT false CHECK ("unborn" IN (0, 1)),
    "upstream_ref" TEXT,
    "ahead_count" INTEGER NOT NULL DEFAULT 0 CHECK ("ahead_count" >= 0),
    "behind_count" INTEGER NOT NULL DEFAULT 0 CHECK ("behind_count" >= 0),
    "staged_count" INTEGER NOT NULL DEFAULT 0 CHECK ("staged_count" >= 0),
    "unstaged_count" INTEGER NOT NULL DEFAULT 0 CHECK ("unstaged_count" >= 0),
    "untracked_count" INTEGER NOT NULL DEFAULT 0 CHECK ("untracked_count" >= 0),
    "conflicted_count" INTEGER NOT NULL DEFAULT 0 CHECK ("conflicted_count" >= 0),
    "path_summary_json" TEXT NOT NULL DEFAULT '[]',
    "stash_count" INTEGER NOT NULL DEFAULT 0 CHECK ("stash_count" >= 0),
    "recent_commit_json" TEXT NOT NULL DEFAULT '{}',
    "remotes_json" TEXT NOT NULL DEFAULT '[]',
    "output_truncated" BOOLEAN NOT NULL DEFAULT false CHECK ("output_truncated" IN (0, 1)),
    "status" TEXT NOT NULL DEFAULT 'fresh' CHECK ("status" IN ('fresh', 'stale', 'error')),
    "error_code" TEXT,
    "error_summary" TEXT,
    "collected_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "git_snapshot_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repository" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "project_enabled_archived_at_sort_order_idx" ON "project"("enabled", "archived_at", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "repository_canonical_path_key" ON "repository"("canonical_path");

-- CreateIndex
CREATE INDEX "repository_project_id_whitelist_status_idx" ON "repository"("project_id", "whitelist_status");

-- CreateIndex
CREATE INDEX "repository_identity_hash_idx" ON "repository"("identity_hash");

-- CreateIndex
CREATE INDEX "repository_remote_host_remote_path_idx" ON "repository"("remote_host", "remote_path");

-- CreateIndex
CREATE INDEX "git_snapshot_repository_id_collected_at_idx" ON "git_snapshot"("repository_id", "collected_at");
