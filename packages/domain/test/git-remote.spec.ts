import { describe, expect, it } from 'vitest';
import { normalizeGitRemote } from '../src/lib/git-remote.js';

describe('Git 远端规范化', () => {
  it.each([
    ['https://oauth2:secret@git.example.com/group/team/repo.git', 'https', 'group/team/repo'],
    ['git@git.example.com:group/team/repo.git', 'ssh', 'group/team/repo'],
    ['ssh://deploy@git.example.com:2222/group/repo.git', 'ssh', 'group/repo'],
  ])('解析 %s 且不保留凭证', (value, protocol, path) => {
    const result = normalizeGitRemote(value);
    expect(result).toMatchObject({ protocol, host: 'git.example.com', path });
    expect(result?.sanitizedUrl).not.toMatch(/oauth2|secret|deploy@/u);
  });

  it.each(['C:\\repo', '../repo', 'file:///repo', 'https://host/only-one-segment'])(
    '%s 不自动匹配 GitLab',
    (value) => {
      expect(normalizeGitRemote(value)).toBeNull();
    },
  );
});
