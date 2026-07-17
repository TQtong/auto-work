import { describe, expect, it } from 'vitest';
import {
  gitlabBranchSchema,
  gitlabCommitSchema,
  gitlabMemberSchema,
  gitlabMergeRequestSchema,
  gitlabPipelineSchema,
  gitlabProjectSchema,
  gitlabReleaseSchema,
  gitlabTagSchema,
} from '../src/modules/gitlab/gitlab.schemas.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

describe('GitLab 脱敏契约样例', () => {
  it('兼容可选字段缺失和服务端新增字段', () => {
    const fixtures: Array<[schema: { parse(value: unknown): unknown }, value: unknown]> = [
      [
        gitlabProjectSchema,
        {
          id: 1,
          name: '项目',
          path_with_namespace: '团队/项目',
          web_url: 'https://git.example.com/group/project',
          server_added_field: true,
        },
      ],
      [gitlabBranchSchema, { name: 'main', commit: { id: sha }, server_added_field: true }],
      [
        gitlabCommitSchema,
        {
          id: sha,
          title: '提交',
          author_name: '研发',
          author_email: 'dev@example.com',
          committed_date: '2026-07-17T10:00:00+08:00',
        },
      ],
      [
        gitlabMergeRequestSchema,
        {
          id: 2,
          iid: 2,
          title: '合并请求',
          state: 'opened',
          source_branch: 'feature',
          target_branch: 'main',
          updated_at: '2026-07-17T10:00:00+08:00',
          web_url: 'https://git.example.com/group/project/-/merge_requests/2',
        },
      ],
      [gitlabPipelineSchema, { id: 3, sha, status: 'success' }],
      [gitlabTagSchema, { name: 'v1.0.0', target: sha }],
      [gitlabReleaseSchema, { tag_name: 'v1.0.0' }],
      [gitlabMemberSchema, { id: 4, username: 'dev', name: '研发', access_level: 30 }],
    ];
    for (const [schema, value] of fixtures) expect(() => schema.parse(value)).not.toThrow();
  });

  it('拒绝会破坏证据关联的非法提交 SHA', () => {
    expect(() =>
      gitlabCommitSchema.parse({
        id: 'not-a-sha',
        title: '提交',
        author_name: '研发',
        author_email: 'dev@example.com',
        committed_date: '2026-07-17T10:00:00+08:00',
      }),
    ).toThrow();
  });
});
