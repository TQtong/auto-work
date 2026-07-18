import { z } from 'zod';

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const createWorkCalendarVersionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    timezone: z.literal('Asia/Shanghai').default('Asia/Shanghai'),
    workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    dateOverrides: z
      .array(
        z
          .object({
            date: businessDateSchema,
            isWorkday: z.boolean(),
            label: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(1_000)
      .default([]),
    source: z.enum(['manual', 'imported']).default('manual'),
  })
  .strict();

export type CreateWorkCalendarVersionInput = z.infer<typeof createWorkCalendarVersionSchema>;
