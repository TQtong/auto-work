import { DomainError, type GitBatchAction } from '@auto-work/contracts';

const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/u;
const FORBIDDEN_REF_PATTERN = /(?:\.\.|@\{|[\s~^:?*\\]|\.$|^\.|\/$|\/\.|\.lock(?:\/|$))/u;

/** Git 批次只接受结构化动作；这个集合同时是 API 与 Worker 的最后一道白名单。 */
export function assertAllowedGitAction(value: string): asserts value is GitBatchAction {
  const allowed: readonly string[] = [
    'fetch_prune',
    'pull_ff_only',
    'create_branch',
    'checkout',
    'push_set_upstream',
    'push',
    'stash_create',
    'stash_apply',
    'stage_paths',
    'commit',
  ];
  if (!allowed.includes(value)) {
    throw new DomainError('GIT_ACTION_FORBIDDEN', '请求的 Git 动作不在固定白名单中', {
      httpStatus: 422,
      details: { action: value },
    });
  }
}

export function assertSafeRemoteName(value: string): string {
  if (!REMOTE_PATTERN.test(value) || value.includes('..')) {
    throw new DomainError('GIT_REMOTE_INVALID', '远端名称格式无效', { httpStatus: 422 });
  }
  return value;
}

/**
 * 先进行无副作用的保守检查，执行前还会调用 git check-ref-format 复核。
 * 禁止以短横线开头可避免值被 Git 当成选项解释。
 */
export function assertSafeRefName(value: string, label = '分支'): string {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith('-') ||
    value.endsWith('/') ||
    value.includes('//') ||
    /[\0\r\n]/u.test(value) ||
    FORBIDDEN_REF_PATTERN.test(value)
  ) {
    throw new DomainError('GIT_REF_INVALID', `${label}名称格式无效`, { httpStatus: 422 });
  }
  return value;
}

export function assertSafeRepositoryPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length < 1 ||
    normalized.length > 1_024 ||
    normalized.startsWith('/') ||
    normalized.startsWith('-') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '') ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new DomainError('GIT_PATH_INVALID', '暂存路径必须是仓库内的明确相对路径', {
      httpStatus: 422,
    });
  }
  return normalized;
}
