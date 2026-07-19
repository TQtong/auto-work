import { z } from 'zod';

const nullableText = z.string().trim().max(4_000).nullable();
const nullableDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .nullable();

export const saveExcelResolutionsSchema = z
  .object({
    version: z.number().int().positive(),
    rows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            version: z.number().int().positive(),
            action: z.enum(['create_excel', 'link_jira', 'skip']),
            matchedTaskId: z.string().min(1).max(100).nullable().optional(),
            fields: z
              .object({
                parentIssueKey: nullableText.optional(),
                parentTitle: nullableText.optional(),
                title: nullableText.optional(),
                assigneeName: nullableText.optional(),
                plannedStartDate: nullableDate.optional(),
                dueDate: nullableDate.optional(),
                estimateHours: z.number().finite().min(0).max(10_000).nullable().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export const commitExcelImportSchema = z
  .object({
    previewVersion: z.number().int().positive(),
    acknowledgedWarnings: z.boolean(),
  })
  .strict();

export type SaveExcelResolutionsInput = z.infer<typeof saveExcelResolutionsSchema>;
export type CommitExcelImportInput = z.infer<typeof commitExcelImportSchema>;
