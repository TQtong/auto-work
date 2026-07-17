import { z } from 'zod';

const nullableString = z.string().nullable().optional();

export const jiraUserSchema = z
  .object({
    accountId: nullableString,
    key: nullableString,
    name: nullableString,
    displayName: z.string().min(1),
    emailAddress: nullableString,
    active: z.boolean().optional(),
    timeZone: nullableString,
  })
  .passthrough();

export const jiraFieldSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    custom: z.boolean().optional(),
    orderable: z.boolean().optional(),
    navigable: z.boolean().optional(),
    searchable: z.boolean().optional(),
    clauseNames: z.array(z.string()).optional(),
    schema: z
      .object({
        type: nullableString,
        items: nullableString,
        system: nullableString,
        custom: nullableString,
        customId: z.number().int().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const jiraProjectSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    key: z.string().min(1),
    name: z.string().min(1),
    projectTypeKey: nullableString,
    simplified: z.boolean().optional(),
    style: nullableString,
    archived: z.boolean().optional(),
  })
  .passthrough();

export const jiraStatusSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().min(1),
    statusCategory: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String).optional(),
        key: nullableString,
        name: nullableString,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const jiraIssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/u),
    fields: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const jiraSearchPageSchema = z
  .object({
    startAt: z.number().int().nonnegative().optional(),
    maxResults: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
    issues: z.array(jiraIssueSchema),
  })
  .passthrough();

export type JiraIssue = z.infer<typeof jiraIssueSchema>;
