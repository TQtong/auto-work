import { z } from 'zod';

export const weeklyReportTemplateFieldSchema = z.enum([
  'reportDate',
  'recentGoals',
  'weeklyWork',
  'nextWeekPlans',
  'problems',
  'other',
]);

export const saveDingTalkTemplateMappingSchema = z
  .object({
    connectionVersion: z.number().int().positive(),
    templateId: z.string().trim().min(1).max(500),
    templateName: z.string().trim().min(1).max(200),
    externalTemplateVersion: z.string().trim().min(1).max(200).nullable().default(null),
    templateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    capabilitySnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    observedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    fields: z
      .array(
        z
          .object({
            internalField: weeklyReportTemplateFieldSchema,
            externalFieldId: z.string().trim().min(1).max(500),
            externalFieldName: z.string().trim().min(1).max(200),
            externalType: z.string().trim().min(1).max(100),
            order: z.number().int().min(0).max(100),
            required: z.boolean(),
            maxLength: z.number().int().positive().max(1_000_000).nullable().default(null),
          })
          .strict(),
      )
      .length(6),
  })
  .strict()
  .superRefine((value, context) => {
    const internal = new Set(value.fields.map((field) => field.internalField));
    const external = new Set(value.fields.map((field) => field.externalFieldId));
    const orders = new Set(value.fields.map((field) => field.order));
    if (internal.size !== 6) {
      context.addIssue({ code: 'custom', message: '六个周报字段必须各映射一次' });
    }
    if (external.size !== 6) {
      context.addIssue({ code: 'custom', message: '钉钉字段 ID 不得重复' });
    }
    if (orders.size !== 6) {
      context.addIssue({ code: 'custom', message: '钉钉字段顺序不得重复' });
    }
    if (new Date(value.expiresAt) <= new Date(value.observedAt)) {
      context.addIssue({ code: 'custom', message: '模板映射失效时间必须晚于探测时间' });
    }
  });

export type SaveDingTalkTemplateMappingInput = z.infer<typeof saveDingTalkTemplateMappingSchema>;
