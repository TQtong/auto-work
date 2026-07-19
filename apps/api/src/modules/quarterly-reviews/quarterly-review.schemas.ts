import { z } from 'zod';

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const metricSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Za-z0-9._-]+$/u),
    name: z.string().trim().min(1).max(200),
    definition: z.string().trim().min(1).max(5_000),
    weight: z.number().finite().min(0).max(10_000),
    minimum: z.number().finite().min(-10_000).max(10_000),
    maximum: z.number().finite().min(-10_000).max(10_000),
    step: z.number().finite().positive().max(10_000),
    required: z.boolean().default(true),
    evidenceRequirement: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const createQuarterlyReviewSchema = z.discriminatedUnion('periodType', [
  z
    .object({
      periodType: z.literal('natural_quarter'),
      year: z.number().int().min(2000).max(2100),
      quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    })
    .strict(),
  z
    .object({
      periodType: z.literal('custom'),
      name: z.string().trim().min(2).max(100),
      periodStart: businessDate,
      periodEnd: businessDate,
    })
    .strict(),
]);

export const listQuarterlyReviewsSchema = z
  .object({
    status: z.string().trim().min(1).max(50).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const createMetricTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    formulaType: z.enum(['weighted_average_100', 'weighted_sum', 'simple_sum']),
    roundingRule: z.enum([
      'none',
      'half_up_integer',
      'half_up_1_decimal',
      'floor_integer',
      'ceil_integer',
    ]),
    metrics: z.array(metricSchema).min(1).max(100),
  })
  .strict();

export const bindMetricTemplateSchema = z
  .object({
    templateVersionId: z.string().trim().min(1).max(100),
    reviewVersion: z.number().int().positive(),
  })
  .strict();

export const updateScoreItemsSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    scores: z
      .array(
        z
          .object({
            metricId: z.string().trim().min(1).max(100),
            userScore: z.number().finite().nullable(),
            userReason: z.string().trim().max(2_000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scores.map((score) => score.metricId)).size !== value.scores.length) {
      context.addIssue({ code: 'custom', message: '评分指标不得重复' });
    }
  });

const narrativeContentSchema = z
  .object({
    overallOverview: z.string().trim().min(1).max(30_000),
    coreAchievements: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(500),
            body: z.string().trim().min(1).max(30_000),
            achievementIds: z.array(z.string().trim().min(1).max(100)).min(1).max(200),
            metricIds: z.array(z.string().trim().min(1).max(100)).max(100),
            evidenceIds: z.array(z.string().trim().min(1).max(100)).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    collaborationAndGrowth: z.string().trim().min(1).max(30_000),
    problemsAndImprovements: z.string().trim().min(1).max(30_000),
    nextPeriodPlan: z.string().trim().min(1).max(30_000),
  })
  .strict();

export const createRuleNarrativeSchema = z
  .object({ reviewVersion: z.number().int().positive() })
  .strict();

export const createManualNarrativeSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    parentVersionId: z.string().trim().min(1).max(100).nullable().default(null),
    content: narrativeContentSchema,
    changeReason: z.string().trim().min(2).max(1_000),
  })
  .strict();

export const restoreNarrativeSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    changeReason: z.string().trim().min(2).max(1_000),
  })
  .strict();

export const generateQuarterlyAiSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    providerConnectionId: z.string().trim().min(1).max(100),
  })
  .strict();

export const decideQuarterlyAiSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    decisionReason: z.string().trim().min(2).max(1_000),
  })
  .strict();

export const confirmQuarterlyReviewSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    narrativeVersionId: z.string().trim().min(1).max(100),
    acknowledgements: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(100),
            reason: z.string().trim().min(2).max(1_000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();

export const collectQuarterlyReviewSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    sources: z
      .object({
        tasks: z.boolean().default(true),
        evidence: z.boolean().default(true),
        confirmedWeeklyReports: z.boolean().default(true),
      })
      .strict()
      .default({ tasks: true, evidence: true, confirmedWeeklyReports: true }),
    freshnessPolicy: z
      .object({
        mode: z.enum(['require_fresh', 'allow_stale']),
        maximumAgeHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90),
      })
      .strict()
      .default({ mode: 'allow_stale', maximumAgeHours: 168 }),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.sources.tasks && !value.sources.evidence && !value.sources.confirmedWeeklyReports) {
      context.addIssue({ code: 'custom', message: '至少选择一种季度成果来源' });
    }
  });

const achievementFields = z
  .object({
    projectId: z.string().trim().min(1).max(100).nullable(),
    title: z.string().trim().min(1).max(500),
    situation: z.string().trim().min(1).max(10_000),
    action: z.string().trim().min(1).max(20_000),
    result: z.string().trim().min(1).max(20_000),
    impact: z.string().trim().min(1).max(20_000),
    contributionBoundary: z.string().trim().min(1).max(5_000),
    periodStart: businessDate,
    periodEnd: businessDate,
  })
  .strict();

export const createManualAchievementSchema = achievementFields.extend({
  reviewVersion: z.number().int().positive(),
});

export const updateAchievementSchema = achievementFields.extend({
  reviewVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  changeReason: z.string().trim().min(2).max(500),
});

export const updateAchievementSelectionSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    actions: z
      .array(
        z
          .object({
            achievementId: z.string().trim().min(1).max(100),
            version: z.number().int().positive(),
            status: z.enum(['candidate', 'selected', 'excluded', 'needs_evidence']),
            reason: z.string().trim().min(2).max(500),
            sortOrder: z.number().int().min(0).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.actions.map((action) => action.achievementId)).size !== value.actions.length
    ) {
      context.addIssue({ code: 'custom', message: '成果选择动作不得重复' });
    }
  });

export const listAchievementsSchema = z
  .object({
    status: z.enum(['candidate', 'selected', 'excluded', 'needs_evidence']).optional(),
    projectId: z.string().trim().min(1).max(100).optional(),
    sourceType: z.enum(['collected', 'manual']).optional(),
    evidenceSourceType: z
      .enum([
        'task',
        'branch',
        'commit',
        'merge_request',
        'pipeline',
        'tag',
        'release',
        'weekly_report',
        'manual_link',
      ])
      .optional(),
    evidenceStatus: z.enum(['complete', 'partial', 'needs_evidence']).optional(),
    metricId: z.string().trim().min(1).max(100).optional(),
    month: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
      .optional(),
    cursor: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const listQuarterlyCollectionSnapshotsSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export const queueQuarterlyExportSchema = z
  .object({
    confirmationId: z.string().trim().min(1).max(100),
    format: z.enum(['xlsx', 'docx']),
  })
  .strict();

export const addAchievementEvidenceSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    achievementVersion: z.number().int().positive(),
    sourceType: z.literal('manual_link'),
    title: z.string().trim().min(1).max(500),
    externalKey: z.string().trim().max(500).nullable(),
    url: z.url().max(2_000).nullable(),
    eventAt: z.iso.datetime({ offset: true }).nullable(),
    availabilityState: z.enum(['available', 'unavailable', 'unknown']).default('available'),
    summary: z.record(z.string(), z.unknown()).default({}),
    contributionAngle: z.string().trim().min(2).max(2_000),
    primaryEvidence: z.boolean().default(false),
  })
  .strict();

export const updateAchievementMetricsSchema = z
  .object({
    reviewVersion: z.number().int().positive(),
    achievementVersion: z.number().int().positive(),
    links: z
      .array(
        z
          .object({
            metricId: z.string().trim().min(1).max(100),
            contribution: z.string().trim().min(2).max(2_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.links.map((link) => link.metricId)).size !== value.links.length) {
      context.addIssue({ code: 'custom', message: '成果指标映射不得重复' });
    }
  });
