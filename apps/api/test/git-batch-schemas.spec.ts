import { describe, expect, it } from 'vitest';
import { previewGitBatchSchema } from '../src/modules/git-batches/git-batch.schemas.js';

const repositoryIds = ['11111111-1111-4111-8111-111111111111'];

describe('Git 批次 API 参数白名单', () => {
  it.each([
    ['fetch_prune', { remote: 'origin' }],
    ['pull_ff_only', {}],
    ['create_branch', { branch: 'feature/中文', baseline: 'main' }],
    ['checkout', { targetBranch: 'main' }],
    ['push_set_upstream', { remote: 'origin', branch: 'feature/new' }],
    ['push', { remote: 'origin', branch: 'main' }],
    ['stash_create', { message: '临时保存', includeUntracked: true }],
    ['stash_apply', { stashOid: '0123456789abcdef0123456789abcdef01234567' }],
    ['stage_paths', { paths: ['src/中文 文件.ts'] }],
    ['commit', { message: 'feat: 完整实现' }],
  ] as const)('接受动作 %s 的专用参数结构', (action, parameters) => {
    expect(previewGitBatchSchema.safeParse({ action, repositoryIds, parameters }).success).toBe(
      true,
    );
  });

  it.each([
    { action: 'reset_hard', parameters: {} },
    { action: 'merge', parameters: { branch: 'main' } },
    { action: 'rebase', parameters: { branch: 'main' } },
    { action: 'push', parameters: { remote: 'origin', branch: 'main', force: true } },
    { action: 'fetch_prune', parameters: { remote: 'origin' }, command: 'git reset --hard' },
    { action: 'stage_paths', parameters: { paths: ['src/a.ts'] }, cwd: 'D:\\outside' },
    { action: 'commit', parameters: { message: 'x' }, args: ['--no-verify'] },
  ])('拒绝无法由正式 API 表达的动作或原始命令字段', (input) => {
    expect(previewGitBatchSchema.safeParse({ repositoryIds, ...input }).success).toBe(false);
  });
});
