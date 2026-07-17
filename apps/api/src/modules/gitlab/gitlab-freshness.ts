const GITLAB_FRESHNESS_WINDOW_MS = 10 * 60_000;

export type GitLabFreshness = 'unknown' | 'refreshing' | 'fresh' | 'stale' | 'error';

/** 页面新鲜度由持久化同步状态和最后完整成功时间共同决定。 */
export function deriveGitLabFreshness(
  syncStatus: string,
  syncedAt: Date | null,
  now = new Date(),
): GitLabFreshness {
  if (syncStatus === 'refreshing') return 'refreshing';
  if (syncStatus === 'error') return 'error';
  if (!syncedAt) return 'unknown';
  return now.getTime() - syncedAt.getTime() <= GITLAB_FRESHNESS_WINDOW_MS ? 'fresh' : 'stale';
}
