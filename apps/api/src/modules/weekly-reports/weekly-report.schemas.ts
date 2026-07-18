import { z } from 'zod';

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const weeklyFieldSchema = z.enum([
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
]);

export const generateWeeklyReportSchema = z
  .object({
    periodStart: businessDateSchema.optional(),
    periodEnd: businessDateSchema.optional(),
    reportDate: businessDateSchema.optional(),
    timezone: z.literal('Asia/Shanghai').default('Asia/Shanghai'),
    calendarVersionId: z.string().trim().min(1).max(100).optional(),
    freshnessPolicy: z
      .object({
        mode: z.enum(['require_fresh', 'allow_stale']).default('require_fresh'),
        taskMaxAgeMinutes: z.number().int().min(1).max(10_080).default(1_440),
        evidenceMaxAgeMinutes: z.number().int().min(1).max(10_080).default(1_440),
      })
      .strict()
      .default({
        mode: 'require_fresh',
        taskMaxAgeMinutes: 1_440,
        evidenceMaxAgeMinutes: 1_440,
      }),
    includeUnconfirmedEvidence: z.boolean().default(false),
    aiProviderConfigId: z.string().trim().min(1).max(100).nullable().default(null),
    manualInputs: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            field: weeklyFieldSchema,
            text: z.string().trim().min(1).max(10_000),
            projectName: z.string().trim().min(1).max(200).nullable().optional(),
            pinned: z.boolean().default(false),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    jiraQuery: z
      .object({
        connectionIds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        projectIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      })
      .strict()
      .default({}),
    templateMappingVersionId: z.string().trim().min(1).max(100).nullable().default(null),
    existingReportPolicy: z.enum(['reject', 'create_version']).default('reject'),
  })
  .strict()
  .superRefine((value, context) => {
    const supplied = [value.periodStart, value.periodEnd, value.reportDate].filter(Boolean).length;
    if (supplied !== 0 && supplied !== 3) {
      context.addIssue({
        code: 'custom',
        message: 'periodStart、periodEnd 和 reportDate 必须同时提供或同时省略',
      });
    }
  });

export const listWeeklyReportsQuerySchema = z
  .object({
    periodFrom: businessDateSchema.optional(),
    periodTo: businessDateSchema.optional(),
    status: z.enum(['collecting', 'generated', 'editing', 'confirmed']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type GenerateWeeklyReportInput = z.infer<typeof generateWeeklyReportSchema>;
export type ListWeeklyReportsQuery = z.infer<typeof listWeeklyReportsQuerySchema>;
