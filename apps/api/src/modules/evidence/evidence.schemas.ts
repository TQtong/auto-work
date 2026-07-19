import { z } from 'zod';

const version = z.number().int().positive();
const optionalExpiry = z.string().datetime({ offset: true }).nullable().optional();

export const confirmEvidenceLinkSchema = z.object({ version, expiresAt: optionalExpiry }).strict();

export const rejectEvidenceLinkSchema = z
  .object({ version, reason: z.string().trim().min(2).max(500) })
  .strict();

export const revokeEvidenceDecisionSchema = z
  .object({ version, reason: z.string().trim().min(2).max(500) })
  .strict();

export const createManualEvidenceLinkSchema = z
  .object({
    taskId: z.string().trim().min(1).max(100),
    evidenceId: z.string().trim().min(1).max(100),
    explanation: z.string().trim().min(2).max(1_000),
    expiresAt: optionalExpiry,
  })
  .strict();

export const batchConfirmEvidenceLinksSchema = z
  .object({
    items: z
      .array(z.object({ id: z.string().trim().min(1).max(100), version }).strict())
      .min(1)
      .max(100),
    expiresAt: optionalExpiry,
  })
  .strict();

export type ConfirmEvidenceLinkInput = z.infer<typeof confirmEvidenceLinkSchema>;
export type RejectEvidenceLinkInput = z.infer<typeof rejectEvidenceLinkSchema>;
export type RevokeEvidenceDecisionInput = z.infer<typeof revokeEvidenceDecisionSchema>;
export type CreateManualEvidenceLinkInput = z.infer<typeof createManualEvidenceLinkSchema>;
export type BatchConfirmEvidenceLinksInput = z.infer<typeof batchConfirmEvidenceLinksSchema>;
