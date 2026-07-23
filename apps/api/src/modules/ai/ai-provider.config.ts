import { z } from 'zod';

export const aiPurposeSchema = z.enum([
  'weekly_report',
  'evidence_suggestion',
  'quarterly_review',
  'score_suggestion',
]);

export const aiProviderConfigSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9_-]*$/u)
      .default('custom'),
    protocol: z.enum(['openai_compatible', 'anthropic', 'gemini']),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    metadataOnly: z.literal(true).default(true),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(180_000),
    maxInputTokens: z.number().int().min(256).max(1_000_000).default(32_000),
    maxOutputTokens: z.number().int().min(128).max(100_000).default(4_096),
    temperaturePolicy: z.enum(['deterministic', 'provider_default']).default('deterministic'),
    temperature: z.number().min(0).max(1).default(0),
    allowedPurposes: z.array(aiPurposeSchema).min(1).max(4),
  })
  .strict();
