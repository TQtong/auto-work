import { z } from 'zod';

const controlSafe = (value: string) => !/[\0\r\n]/u.test(value);
const remote = z.string().min(1).max(101).refine(controlSafe);
const ref = z.string().trim().min(1).max(255).refine(controlSafe);
const path = z.string().min(1).max(1_024).refine(controlSafe);

const common = {
  repositoryIds: z.array(z.string().uuid()).min(1).max(50),
  clientContext: z
    .object({ sourcePage: z.string().max(100).optional(), note: z.string().max(500).optional() })
    .strict()
    .optional(),
};

export const previewGitBatchSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('fetch_prune'),
      parameters: z.object({ remote }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('pull_ff_only'),
      parameters: z.object({ remote: remote.optional(), branch: ref.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('create_branch'),
      parameters: z.object({ branch: ref, baseline: ref }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('checkout'),
      parameters: z.object({ targetBranch: ref }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('push_set_upstream'),
      parameters: z.object({ remote, branch: ref }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('push'),
      parameters: z.object({ remote, branch: ref }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('stash_create'),
      parameters: z
        .object({ message: z.string().trim().min(1).max(200), includeUntracked: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('stash_apply'),
      parameters: z.object({ stashOid: z.string().regex(/^[0-9a-f]{40,64}$/u) }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('stage_paths'),
      parameters: z.object({ paths: z.array(path).min(1).max(200) }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('commit'),
      parameters: z.object({ message: z.string().trim().min(1).max(5_000) }).strict(),
    })
    .strict(),
]);

export const approveGitBatchSchema = z
  .object({
    batchVersion: z.number().int().positive(),
    selectedItemIds: z.array(z.string().uuid()).min(1).max(50),
    acknowledgedWarningIds: z.array(z.string().min(1).max(200)).max(500).default([]),
    confirmation: z.union([z.boolean(), z.string().trim().min(1).max(100)]),
  })
  .strict();

export const cancelGitBatchSchema = z
  .object({ reason: z.string().trim().min(1).max(500).default('用户取消未开始的批次') })
  .strict();

export type PreviewGitBatchInput = z.infer<typeof previewGitBatchSchema>;
export type ApproveGitBatchInput = z.infer<typeof approveGitBatchSchema>;
