import { z } from 'zod';

const dingTalkIntegerSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/u)])
  .transform((value) => Number(value));

export const dingTalkAccessTokenSchema = z
  .object({
    accessToken: z.string().min(8).max(4_096),
    expireIn: z.number().int().positive().max(86_400),
  })
  .passthrough();

export const dingTalkTemplateResponseSchema = z
  .object({
    errcode: z.number().int(),
    errmsg: z.string().max(1_000).optional(),
    request_id: z.string().max(500).optional(),
    result: z
      .object({
        id: z.string().min(1).max(500),
        name: z.string().min(1).max(200),
        userid: z.string().min(1).max(500),
        user_name: z.string().max(200).optional(),
        fields: z
          .array(
            z
              .object({
                field_name: z.string().min(1).max(200),
                sort: dingTalkIntegerSchema,
                type: dingTalkIntegerSchema,
              })
              .passthrough(),
          )
          .min(1)
          .max(100),
        default_receivers: z
          .array(
            z
              .object({
                userid: z.string().min(1).max(500),
                user_name: z.string().min(1).max(200),
              })
              .passthrough(),
          )
          .max(1_000)
          .default([]),
        default_received_convs: z
          .array(
            z
              .object({
                conversation_id: z.string().min(1).max(500),
                title: z.string().min(1).max(200),
              })
              .passthrough(),
          )
          .max(1_000)
          .default([]),
      })
      .passthrough(),
  })
  .passthrough();

export const dingTalkRobotResponseSchema = z
  .object({
    errcode: z.number().int(),
    errmsg: z.string().max(1_000).optional(),
    request_id: z.string().max(500).optional(),
  })
  .passthrough();

export const dingTalkCreateReportResponseSchema = z
  .object({
    errcode: z.number().int(),
    errmsg: z.string().max(1_000).optional(),
    request_id: z.string().max(500).optional(),
    result: z.union([
      z.string().min(1).max(500),
      z
        .object({
          report_id: z.string().min(1).max(500),
        })
        .passthrough(),
    ]),
  })
  .passthrough();
