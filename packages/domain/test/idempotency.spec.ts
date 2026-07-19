import { describe, expect, it } from 'vitest';
import { assertIdempotentReplay } from '../src/lib/idempotency.js';

describe('幂等复放规则', () => {
  it('同请求哈希返回第一次结果', () => {
    expect(
      assertIdempotentReplay(
        { requestHash: 'same', state: 'completed', result: { id: 'one' } },
        'same',
      ),
    ).toEqual({ id: 'one' });
  });

  it('同一幂等键的不同请求被拒绝', () => {
    expect(() => assertIdempotentReplay({ requestHash: 'old', state: 'completed' }, 'new')).toThrow(
      '幂等键已用于不同请求',
    );
  });
});
