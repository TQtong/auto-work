import { z } from 'zod';

export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '业务日期必须使用 YYYY-MM-DD');

export const utcInstantSchema = z.string().datetime({ offset: true });

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
