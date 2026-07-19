import { describe, expect, it } from 'vitest';
import { deriveGitLabFreshness } from '../src/modules/gitlab/gitlab-freshness.js';

describe('GitLab 缓存新鲜度', () => {
  const now = new Date('2026-07-17T10:20:00.000Z');

  it('区分无快照、刷新中、错误、新鲜和过期', () => {
    expect(deriveGitLabFreshness('unknown', null, now)).toBe('unknown');
    expect(deriveGitLabFreshness('refreshing', null, now)).toBe('refreshing');
    expect(deriveGitLabFreshness('error', new Date('2026-07-17T10:19:00.000Z'), now)).toBe('error');
    expect(deriveGitLabFreshness('fresh', new Date('2026-07-17T10:10:00.000Z'), now)).toBe('fresh');
    expect(deriveGitLabFreshness('fresh', new Date('2026-07-17T10:09:59.999Z'), now)).toBe('stale');
  });
});
