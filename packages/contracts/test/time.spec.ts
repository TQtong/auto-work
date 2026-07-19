import { describe, expect, it } from 'vitest';
import { businessDateSchema, cursorQuerySchema } from '../src/index.js';

describe('HTTP 公共契约', () => {
  it('严格区分业务日期和时间点', () => {
    expect(businessDateSchema.parse('2026-07-17')).toBe('2026-07-17');
    expect(() => businessDateSchema.parse('2026/07/17')).toThrow();
  });

  it('把分页上限限制为 200', () => {
    expect(cursorQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(() => cursorQuerySchema.parse({ limit: 201 })).toThrow();
  });
});
