import { z } from 'zod';

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    // 不能只校验字符串格式，否则 2026-02-30 会被 JavaScript 自动滚动到三月。
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, '业务日期不是有效公历日期');
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
    if (
      value.periodStart &&
      value.periodEnd &&
      value.reportDate &&
      (value.periodStart > value.periodEnd ||
        value.reportDate < value.periodStart ||
        value.reportDate > value.periodEnd)
    ) {
      context.addIssue({
        code: 'custom',
        message: '周报周期起止必须有序，填写日期必须位于周期内',
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

const editableFieldsSchema = z
  .object({
    reportDate: businessDateSchema.optional(),
    recentGoals: z.string().max(50_000).optional(),
    weeklyWork: z.string().max(50_000).optional(),
    nextWeekPlans: z.string().max(50_000).optional(),
    problems: z.string().max(50_000).optional(),
    other: z.string().max(50_000).optional(),
  })
  .strict();

export const editWeeklyReportSchema = z
  .object({
    baseVersionId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
    fields: editableFieldsSchema.default({}),
    attachmentIds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    recipientValidationIds: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
    templateMappingVersionId: z.string().trim().min(1).max(100).nullable().optional(),
    scheduleAt: z.iso.datetime({ offset: true }).nullable().optional(),
    changeReason: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Object.keys(value.fields).length === 0 &&
      value.attachmentIds === undefined &&
      value.recipientValidationIds === undefined &&
      value.templateMappingVersionId === undefined &&
      value.scheduleAt === undefined
    ) {
      context.addIssue({ code: 'custom', message: '至少修改一个正文或提交元数据字段' });
    }
    if (value.attachmentIds && new Set(value.attachmentIds).size !== value.attachmentIds.length) {
      context.addIssue({ code: 'custom', message: '附件 ID 不得重复' });
    }
    if (
      value.recipientValidationIds &&
      new Set(value.recipientValidationIds).size !== value.recipientValidationIds.length
    ) {
      context.addIssue({ code: 'custom', message: '收件人校验快照 ID 不得重复' });
    }
  });

export const restoreWeeklyReportVersionSchema = z
  .object({
    baseVersionId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
    changeReason: z.string().trim().min(1).max(500),
  })
  .strict();

export const confirmWeeklyReportSchema = z
  .object({
    versionId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
    templateMappingVersionId: z.string().trim().min(1).max(100),
    acknowledgedWarningIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.acknowledgedWarningIds).size !== value.acknowledgedWarningIds.length) {
      context.addIssue({ code: 'custom', message: 'warning 知悉 ID 不得重复' });
    }
  });

export const createWeeklyAiSuggestionSchema = z
  .object({
    baseVersionId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
    providerConnectionId: z.string().trim().min(1).max(100),
    fields: z.array(weeklyFieldSchema).min(1).max(5),
    consent: z
      .object({
        allowPeopleNames: z.boolean().default(false),
        allowInternalUrls: z.boolean().default(false),
        allowDescriptionSummaries: z.boolean().default(false),
      })
      .strict()
      .default({
        allowPeopleNames: false,
        allowInternalUrls: false,
        allowDescriptionSummaries: false,
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.fields).size !== value.fields.length) {
      context.addIssue({ code: 'custom', message: 'AI 改写栏位不得重复' });
    }
  });

export const adoptWeeklyAiSuggestionSchema = z
  .object({
    suggestionVersionId: z.string().trim().min(1).max(100),
    baseVersionId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
    decisionReason: z.string().trim().min(1).max(500),
  })
  .strict();

export const rejectWeeklyAiSuggestionSchema = z
  .object({
    decisionReason: z.string().trim().min(1).max(500),
  })
  .strict();

export const submitWeeklyReportLogSchema = z
  .object({
    confirmationId: z.string().trim().min(1).max(100),
    confirmedVersionId: z.string().trim().min(1).max(100),
    recipientScopeHash: z.string().regex(/^[a-f0-9]{64}$/u),
    reportVersion: z.number().int().positive(),
  })
  .strict();

export const notifyWeeklyReportGroupSchema = z
  .object({
    confirmationId: z.string().trim().min(1).max(100),
    robotConnectionId: z.string().trim().min(1).max(100),
    notificationType: z.literal('submission_success'),
    reportVersion: z.number().int().positive(),
  })
  .strict();

export const notifyWeeklyReportFailureSchema = z
  .object({
    robotConnectionId: z.string().trim().min(1).max(100),
    failedDeliveryIntentId: z.string().trim().min(1).max(100),
    reportVersion: z.number().int().positive(),
  })
  .strict();

export const reconcileWeeklyReportDeliverySchema = z
  .object({
    intentVersion: z.number().int().positive(),
  })
  .strict();

export const retryWeeklyReportDeliverySchema = z
  .object({
    intentVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const resolveWeeklyReportDeliverySchema = z
  .object({
    intentVersion: z.number().int().positive(),
    resolution: z.enum(['delivered', 'not_delivered']),
    externalId: z.string().trim().min(1).max(500).nullable().default(null),
    externalUrl: z.url().max(2_000).nullable().default(null),
    reason: z.string().trim().min(5).max(500),
    confirmationPhrase: z.literal('我已在钉钉人工核对交付结果'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resolution === 'delivered' && !value.externalId) {
      context.addIssue({
        code: 'custom',
        path: ['externalId'],
        message: '确认已交付时必须填写钉钉日志 ID',
      });
    }
    if (value.resolution === 'not_delivered' && (value.externalId || value.externalUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['externalId'],
        message: '确认未交付时不得填写外部 ID 或链接',
      });
    }
  });

export type GenerateWeeklyReportInput = z.infer<typeof generateWeeklyReportSchema>;
export type ListWeeklyReportsQuery = z.infer<typeof listWeeklyReportsQuerySchema>;
export type EditWeeklyReportInput = z.infer<typeof editWeeklyReportSchema>;
export type RestoreWeeklyReportVersionInput = z.infer<typeof restoreWeeklyReportVersionSchema>;
export type ConfirmWeeklyReportInput = z.infer<typeof confirmWeeklyReportSchema>;
export type CreateWeeklyAiSuggestionInput = z.infer<typeof createWeeklyAiSuggestionSchema>;
export type AdoptWeeklyAiSuggestionInput = z.infer<typeof adoptWeeklyAiSuggestionSchema>;
export type RejectWeeklyAiSuggestionInput = z.infer<typeof rejectWeeklyAiSuggestionSchema>;
export type SubmitWeeklyReportLogInput = z.infer<typeof submitWeeklyReportLogSchema>;
export type NotifyWeeklyReportGroupInput = z.infer<typeof notifyWeeklyReportGroupSchema>;
export type NotifyWeeklyReportFailureInput = z.infer<typeof notifyWeeklyReportFailureSchema>;
export type ReconcileWeeklyReportDeliveryInput = z.infer<
  typeof reconcileWeeklyReportDeliverySchema
>;
export type RetryWeeklyReportDeliveryInput = z.infer<typeof retryWeeklyReportDeliverySchema>;
export type ResolveWeeklyReportDeliveryInput = z.infer<typeof resolveWeeklyReportDeliverySchema>;
