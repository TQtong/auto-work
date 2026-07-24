import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { GitProcessService } from '../src/infrastructure/git/git-process.service.js';
import type { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';
import {
  createBranchesSchema,
  deleteBranchSchema,
} from '../src/modules/git-batches/git-branches.schemas.js';
import { GitBranchesService } from '../src/modules/git-batches/git-branches.service.js';
import type { RepositoryWriteLockService } from '../src/modules/git-batches/repository-write-lock.service.js';

const repository = {
  id: '11111111-1111-4111-8111-111111111111',
  canonicalPath: 'D:\\repositories\\demo',
  identityHash: 'identity-1',
  whitelistStatus: 'confirmed',
};

function branchLine(
  fullName: string,
  oid: string,
  updatedAt: string,
  subject: string,
  head = ' ',
  symref = '',
) {
  return [fullName, oid, updatedAt, subject, head, symref].join('\0');
}

function createService(branchOutput: string) {
  const prisma = {
    repository: {
      findUnique: vi.fn((input: { where: { id: string } }) =>
        Promise.resolve({ ...repository, id: input.where.id }),
      ),
    },
  } as unknown as PrismaService;
  const runRead = vi.fn((_cwd: string, args: readonly string[]) => {
    if (args[0] === 'for-each-ref') {
      return Promise.resolve({
        stdout: Buffer.from(branchOutput),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      });
    }
    if (args[0] === 'check-ref-format') {
      return Promise.resolve({
        stdout: Buffer.alloc(0),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      });
    }
    if (args[0] === 'show-ref') {
      return Promise.resolve({
        stdout: Buffer.alloc(0),
        stderr: '',
        exitCode: 1,
        durationMs: 1,
      });
    }
    throw new Error(`unexpected git read: ${args.join(' ')}`);
  });
  const runWrite = vi.fn().mockResolvedValue({
    stdout: Buffer.alloc(0),
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  });
  const git = {
    runRead,
    runWrite,
  } as unknown as GitProcessService;
  const inspector = {
    inspect: vi.fn().mockResolvedValue({ identityHash: repository.identityHash }),
  } as unknown as RepositoryInspectorService;
  const locks = {
    acquire: vi.fn().mockResolvedValue(vi.fn()),
  } as unknown as RepositoryWriteLockService;
  return { service: new GitBranchesService(prisma, git, inspector, locks), runRead, runWrite };
}

describe('Git 分支管理', () => {
  it('列出本地与远程分支并按最近提交时间倒序，忽略远程 HEAD 符号引用', async () => {
    const oidA = 'a'.repeat(40);
    const oidB = 'b'.repeat(40);
    const output = [
      branchLine('refs/heads/main', oidA, '2026-07-18T08:00:00+08:00', 'older', '*'),
      branchLine('refs/remotes/origin/feature', oidB, '2026-07-20T09:00:00+08:00', 'newer'),
      branchLine(
        'refs/remotes/origin/HEAD',
        oidA,
        '2026-07-18T08:00:00+08:00',
        'pointer',
        ' ',
        'refs/remotes/origin/main',
      ),
    ].join('\n');
    const { service } = createService(output);

    const result = await service.list(repository.id);

    expect(result.map((branch) => branch.fullName)).toEqual([
      'refs/remotes/origin/feature',
      'refs/heads/main',
    ]);
    expect(result[1]).toMatchObject({ scope: 'local', current: true });
  });

  it('一次请求为多个仓库创建分支，且不切换工作区', async () => {
    const oid = 'c'.repeat(40);
    const { service, runWrite } = createService(
      branchLine('refs/remotes/origin/main', oid, '2026-07-20T09:00:00+08:00', 'baseline'),
    );

    const result = await service.create({
      repositories: [
        {
          repositoryId: repository.id,
          baselineRef: 'refs/remotes/origin/main',
          branchNames: ['feature/one', 'feature/two'],
        },
        {
          repositoryId: '22222222-2222-4222-8222-222222222222',
          baselineRef: 'refs/remotes/origin/main',
          branchNames: ['release/one'],
        },
      ],
    });

    expect(result.summary).toEqual({
      repositories: 2,
      total: 3,
      created: 3,
      alreadyExists: 0,
      failed: 0,
    });
    expect(runWrite).toHaveBeenNthCalledWith(
      1,
      repository.canonicalPath,
      ['branch', '--no-track', 'feature/one', oid],
      expect.any(Object),
    );
    expect(runWrite).toHaveBeenNthCalledWith(
      3,
      repository.canonicalPath,
      ['branch', '--no-track', 'release/one', oid],
      expect.any(Object),
    );
    expect(runWrite).toHaveBeenNthCalledWith(
      2,
      repository.canonicalPath,
      ['branch', '--no-track', 'feature/two', oid],
      expect.any(Object),
    );
  });

  it('同名分支指向不同提交时整批拒绝且不执行写操作', async () => {
    const baselineOid = 'd'.repeat(40);
    const { service, runRead, runWrite } = createService(
      branchLine('refs/heads/main', baselineOid, '2026-07-20T09:00:00+08:00', 'baseline'),
    );
    runRead.mockImplementation((_cwd, args) => {
      if (args[0] === 'for-each-ref') {
        return Promise.resolve({
          stdout: Buffer.from(
            branchLine('refs/heads/main', baselineOid, '2026-07-20T09:00:00+08:00', 'baseline'),
          ),
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        });
      }
      if (args[0] === 'check-ref-format') {
        return Promise.resolve({
          stdout: Buffer.alloc(0),
          stderr: '',
          exitCode: 0,
          durationMs: 1,
        });
      }
      return Promise.resolve({
        stdout: Buffer.from('e'.repeat(40)),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      });
    });

    const result = await service.create({
      repositories: [
        {
          repositoryId: repository.id,
          baselineRef: 'refs/heads/main',
          branchNames: ['feature/existing', 'feature/new'],
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.repositories[0]).toMatchObject({
      repositoryId: repository.id,
      status: 'failed',
      summary: { total: 2, created: 0, failed: 2 },
    });
    expect(runWrite).not.toHaveBeenCalled();
  });

  it('拒绝在同一批请求中重复配置仓库', () => {
    const plan = {
      repositoryId: repository.id,
      baselineRef: 'refs/heads/main',
      branchNames: ['feature/one'],
    };
    expect(createBranchesSchema.safeParse({ repositories: [plan, plan] }).success).toBe(false);
  });

  it('按列表快照删除本地非当前分支', async () => {
    const oid = 'f'.repeat(40);
    const { service, runWrite } = createService(
      branchLine('refs/heads/feature/wrong', oid, '2026-07-20T09:00:00+08:00', 'wrong'),
    );

    const result = await service.delete({
      repositoryId: repository.id,
      branchName: 'feature/wrong',
      expectedOid: oid,
    });

    expect(result).toMatchObject({
      status: 'deleted',
      branchName: 'feature/wrong',
      deletedOid: oid,
    });
    expect(runWrite).toHaveBeenCalledWith(
      repository.canonicalPath,
      ['update-ref', '-d', 'refs/heads/feature/wrong', oid],
      expect.any(Object),
    );
  });

  it('禁止删除当前分支，也拒绝已变化的分支快照', async () => {
    const oid = 'a'.repeat(40);
    const current = createService(
      branchLine('refs/heads/main', oid, '2026-07-20T09:00:00+08:00', 'main', '*'),
    );
    await expect(
      current.service.delete({
        repositoryId: repository.id,
        branchName: 'main',
        expectedOid: oid,
      }),
    ).rejects.toMatchObject({ code: 'GIT_CURRENT_BRANCH_DELETE_FORBIDDEN' });
    expect(current.runWrite).not.toHaveBeenCalled();

    const changed = createService(
      branchLine('refs/heads/feature', oid, '2026-07-20T09:00:00+08:00', 'changed'),
    );
    await expect(
      changed.service.delete({
        repositoryId: repository.id,
        branchName: 'feature',
        expectedOid: 'b'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'GIT_BRANCH_CHANGED' });
    expect(changed.runWrite).not.toHaveBeenCalled();
  });

  it('删除接口只接受仓库、分支名和预期提交 SHA', () => {
    expect(
      deleteBranchSchema.safeParse({
        repositoryId: repository.id,
        branchName: 'feature/wrong',
        expectedOid: 'f'.repeat(40),
      }).success,
    ).toBe(true);
    expect(
      deleteBranchSchema.safeParse({
        repositoryId: repository.id,
        branchName: 'feature/wrong',
        expectedOid: 'f'.repeat(40),
        remote: true,
      }).success,
    ).toBe(false);
  });
});
