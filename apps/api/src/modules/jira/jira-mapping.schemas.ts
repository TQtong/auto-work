import { normalizedTaskStatuses } from '@auto-work/contracts';
import { z } from 'zod';

const fieldId = z.string().trim().min(1).max(255);

export const jiraMappingInputSchema = z
  .object({
    fieldMappings: z
      .object({
        plannedStartDate: fieldId.nullable(),
        dueDate: fieldId,
        sprint: fieldId.nullable(),
        parent: fieldId,
        originalEstimateSeconds: fieldId,
        remainingEstimateSeconds: fieldId,
        timeSpentSeconds: fieldId,
        assignee: fieldId,
        status: fieldId,
        priority: fieldId,
        labels: fieldId,
        components: fieldId,
      })
      .strict(),
    statusMappings: z.record(z.string().min(1).max(255), z.enum(normalizedTaskStatuses)),
    parserRules: z
      .object({
        parentFallbackFieldId: fieldId.nullable().default(null),
        sprintStringFallback: z.boolean().default(true),
        preserveUnknownStatus: z.literal(true).default(true),
      })
      .strict()
      .default({
        parentFallbackFieldId: null,
        sprintStringFallback: true,
        preserveUnknownStatus: true,
      }),
  })
  .strict();

export type JiraMappingInput = z.infer<typeof jiraMappingInputSchema>;
