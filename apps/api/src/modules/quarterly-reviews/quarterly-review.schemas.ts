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
