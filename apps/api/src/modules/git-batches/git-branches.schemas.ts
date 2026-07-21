import { z } from 'zod';

const controlSafeRef = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/u.test(value));

const repositoryBranchPlanSchema = z
  .object({
    repositoryId: z.string().uuid(),
    baselineRef: controlSafeRef,
    branchNames: z.array(controlSafeRef).min(1).max(50),
  })
  .strict();

export const createBranchesSchema = z
  .object({
    repositories: z
      .array(repositoryBranchPlanSchema)
      .min(1)
      .max(50)
      .refine(
        (plans) => new Set(plans.map((plan) => plan.repositoryId)).size === plans.length,
        '同一个仓库只能配置一次',
      ),
  })
  .strict();

export const deleteBranchSchema = z
  .object({
    repositoryId: z.string().uuid(),
    branchName: controlSafeRef,
    expectedOid: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict();

export type CreateBranchesInput = z.infer<typeof createBranchesSchema>;
export type RepositoryBranchPlanInput = z.infer<typeof repositoryBranchPlanSchema>;
export type DeleteBranchInput = z.infer<typeof deleteBranchSchema>;
