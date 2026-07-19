import { describe, expect, it } from 'vitest';
import { requestHash, stableJson } from '../src/lib/hash.js';

describe('稳定请求哈希', () => {
  it('对象键顺序不影响哈希', () => {
    expect(requestHash({ b: 2, a: { y: 2, x: 1 } })).toBe(requestHash({ a: { x: 1, y: 2 }, b: 2 }));
  });

  it('数组顺序仍属于业务语义', () => {
    expect(stableJson([2, 1])).not.toBe(stableJson([1, 2]));
  });
});
