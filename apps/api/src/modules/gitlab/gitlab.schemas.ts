import { z } from 'zod';

const externalId = z.union([z.number().int().nonnegative(), z.string().min(1)]);
const optionalDate = z.string().datetime({ offset: true }).nullable().optional();

export const gitlabVersionSchema = z
  .object({ version: z.string().min(1), revision: z.string().optional() })
  .passthrough();

export const gitlabUserSchema = z
  .object({
    id: externalId,
    username: z.string().min(1),
    name: z.string().min(1),
    email: z.string().nullable().optional(),
    public_email: z.string().nullable().optional(),
  })
  .passthrough();

export const gitlabProjectSchema = z
  .object({
    id: externalId,
    name: z.string().min(1),
    path_with_namespace: z.string().min(1),
    web_url: z.string().url(),
    default_branch: z.string().nullable().optional(),
    visibility: z.string().default('unknown'),
    archived: z.boolean().default(false),
    last_activity_at: optionalDate,
    namespace: z.unknown().optional(),
  })
  .passthrough();

export const gitlabBranchSchema = z
  .object({
    name: z.string().min(1),
    merged: z.boolean().default(false),
    protected: z.boolean().default(false),
    default: z.boolean().default(false),
    web_url: z.string().url().nullable().optional(),
    commit: z.object({ id: z.string().regex(/^[0-9a-f]{40,64}$/iu) }).passthrough(),
  })
  .passthrough();

export const gitlabCommitSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    short_id: z.string().optional(),
    title: z.string(),
    message: z.string().optional().default(''),
    author_name: z.string(),
    author_email: z.string(),
    committer_name: z.string().nullable().optional(),
    committer_email: z.string().nullable().optional(),
    authored_date: optionalDate,
    committed_date: z.string().datetime({ offset: true }),
    web_url: z.string().url().nullable().optional(),
  })
  .passthrough();

export const gitlabMergeRequestSchema = z
  .object({
    id: externalId,
    iid: z.number().int().nonnegative(),
    title: z.string(),
    state: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
    author: z.unknown().optional(),
    assignees: z.array(z.unknown()).optional().default([]),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    merged_at: optionalDate,
    closed_at: optionalDate,
    updated_at: z.string().datetime({ offset: true }),
    web_url: z.string().url(),
  })
  .passthrough();

export const gitlabPipelineSchema = z
  .object({
    id: externalId,
    iid: z.number().int().nonnegative().nullable().optional(),
    sha: z.string().min(7),
    ref: z.string().nullable().optional(),
    status: z.string(),
    source: z.string().nullable().optional(),
    web_url: z.string().url().nullable().optional(),
    created_at: optionalDate,
    updated_at: optionalDate,
  })
  .passthrough();

export const gitlabTagSchema = z
  .object({
    name: z.string().min(1),
    target: z.string().min(7),
    message: z.string().nullable().optional(),
    protected: z.boolean().default(false),
    web_url: z.string().url().nullable().optional(),
    created_at: optionalDate,
    commit: z
      .object({ id: z.string().min(7) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const gitlabReleaseSchema = z
  .object({
    tag_name: z.string().min(1),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    released_at: optionalDate,
    created_at: optionalDate,
    upcoming_release: z.boolean().default(false),
    assets: z.unknown().optional(),
    _links: z.object({ self: z.string().url().optional() }).passthrough().optional(),
  })
  .passthrough();

export const gitlabMemberSchema = z
  .object({
    id: externalId,
    username: z.string().min(1),
    name: z.string().min(1),
    state: z.string().nullable().optional(),
    access_level: z.number().int().nonnegative(),
    web_url: z.string().url().nullable().optional(),
    avatar_url: z.string().url().nullable().optional(),
    expires_at: z.string().nullable().optional(),
  })
  .passthrough();
