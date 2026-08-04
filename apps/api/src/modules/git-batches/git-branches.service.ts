import { Injectable } from '@nestjs/common';
import { DomainError, errorCodes } from '@auto-work/contracts';
import { assertSafeRefName } from '@auto-work/domain';
import type { Repository } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { GitProcessService } from '../../infrastructure/git/git-process.service.js';
import {
  repositoryIdentityMatches,
  RepositoryInspectorService,
} from '../repositories/repository-inspector.service.js';
import { RepositoryWriteLockService } from './repository-write-lock.service.js';
import type {
  CreateBranchesInput,
  DeleteBranchInput,
  RepositoryBranchPlanInput,
} from './git-branches.schemas.js';

export interface GitBranchView {
  name: string;
  fullName: string;
  scope: 'local' | 'remote';
  remote: string | null;
  oid: string;
  updatedAt: string;
  subject: string;
  current: boolean;
}

export interface CreateBranchResult {
  branchName: string;
  status: 'created' | 'already_exists' | 'failed';
  message: string;
}

export interface RepositoryBranchResult {
  repositoryId: string;
  status: 'completed' | 'partial_failed' | 'failed';
  baseline: { fullName: string; name: string; oid: string } | null;
  summary: { total: number; created: number; alreadyExists: number; failed: number };
  results: CreateBranchResult[];
  error: string | null;
}

@Injectable()
export class GitBranchesService {
  public constructor(
    private readonly prisma: PrismaService,
    private readonly git: GitProcessService,
    private readonly inspector: RepositoryInspectorService,
    private readonly locks: RepositoryWriteLockService,
  ) {}

  public async list(repositoryId: string): Promise<GitBranchView[]> {
    const repository = await this.confirmedRepository(repositoryId);
    return this.readBranches(repository.canonicalPath);
  }

  public async create(input: CreateBranchesInput) {
    const repositories: RepositoryBranchResult[] = [];
    for (const plan of input.repositories) {
      try {
        repositories.push(await this.createForRepository(plan));
      } catch (error) {
        const branchNames = [...new Set(plan.branchNames.map((name) => name.trim()))];
        const message = error instanceof DomainError ? error.message : '创建分支时发生未知错误';
        repositories.push({
          repositoryId: plan.repositoryId,
          status: 'failed',
          baseline: null,
          summary: {
            total: branchNames.length,
            created: 0,
            alreadyExists: 0,
            failed: branchNames.length,
          },
          results: branchNames.map((branchName) => ({
            branchName,
            status: 'failed',
            message,
          })),
          error: message,
        });
      }
    }

    const summary = repositories.reduce(
      (total, repository) => ({
        repositories: total.repositories + 1,
        total: total.total + repository.summary.total,
        created: total.created + repository.summary.created,
        alreadyExists: total.alreadyExists + repository.summary.alreadyExists,
        failed: total.failed + repository.summary.failed,
      }),
      { repositories: 0, total: 0, created: 0, alreadyExists: 0, failed: 0 },
    );
    return {
      status:
        summary.failed === 0 ? 'completed' : summary.created > 0 ? 'partial_failed' : 'failed',
      summary,
      repositories,
    };
  }

  public async delete(input: DeleteBranchInput) {
    const repository = await this.confirmedRepository(input.repositoryId);
    const release = await this.locks.acquire(repository.id);
    try {
      await this.assertIdentity(repository);
      const branchName = assertSafeRefName(input.branchName, '待删除分支');
      const checked = await this.git.runRead(
        repository.canonicalPath,
        ['check-ref-format', '--branch', branchName],
        { allowExitCodes: [0, 128] },
      );
      if (checked.exitCode !== 0) {
        throw new DomainError('GIT_REF_INVALID', 'Git 拒绝该分支名称', { httpStatus: 422 });
      }

      const branch = (await this.readBranches(repository.canonicalPath)).find(
        (item) => item.fullName === `refs/heads/${branchName}`,
      );
      if (!branch) {
        return {
          repositoryId: repository.id,
          branchName,
          status: 'already_absent' as const,
          deletedOid: null,
          message: '本地分支已不存在，无需重复删除',
        };
      }
      if (branch.current) {
        throw new DomainError('GIT_CURRENT_BRANCH_DELETE_FORBIDDEN', '不能删除当前检出的分支', {
          httpStatus: 409,
        });
      }
      if (branch.oid !== input.expectedOid) {
        throw new DomainError(
          'GIT_BRANCH_CHANGED',
          '分支在页面加载后已指向新的提交，未执行删除，请刷新后重试',
          { httpStatus: 409, suggestedAction: 'refresh' },
        );
      }

      const result = await this.git.runWrite(
        repository.canonicalPath,
        ['update-ref', '-d', `refs/heads/${branchName}`, input.expectedOid],
        { timeoutMs: 30_000, allowExitCodes: [0, 1, 128] },
      );
      if (result.exitCode !== 0) {
        throw new DomainError('GIT_BRANCH_DELETE_FAILED', 'Git 未能删除该本地分支', {
          httpStatus: 422,
          details: { stderr: result.stderr },
        });
      }
      if (await this.refOid(repository.canonicalPath, `refs/heads/${branchName}`)) {
        throw new DomainError('GIT_BRANCH_DELETE_UNCONFIRMED', '删除后仍检测到该分支，请人工复核', {
          httpStatus: 409,
          suggestedAction: 'manual_review',
        });
      }
      return {
        repositoryId: repository.id,
        branchName,
        status: 'deleted' as const,
        deletedOid: branch.oid,
        message: '本地分支已删除',
      };
    } finally {
      release();
    }
  }

  private async createForRepository(
    input: RepositoryBranchPlanInput,
  ): Promise<RepositoryBranchResult> {
    const repository = await this.confirmedRepository(input.repositoryId);
    const release = await this.locks.acquire(repository.id);
    try {
      await this.assertIdentity(repository);
      const branches = await this.readBranches(repository.canonicalPath);
      const baseline = branches.find((branch) => branch.fullName === input.baselineRef);
      if (!baseline) {
        throw new DomainError('GIT_BASELINE_NOT_FOUND', '所选基准分支已不存在，请刷新后重试', {
          httpStatus: 409,
          suggestedAction: 'refresh',
        });
      }

      const branchNames = [...new Set(input.branchNames.map((name) => name.trim()))];
      for (const branchName of branchNames) {
        assertSafeRefName(branchName, '新分支');
        const checked = await this.git.runRead(
          repository.canonicalPath,
          ['check-ref-format', '--branch', branchName],
          { allowExitCodes: [0, 128] },
        );
        if (checked.exitCode !== 0) {
          throw new DomainError('GIT_REF_INVALID', `Git 拒绝分支名称：${branchName}`, {
            httpStatus: 422,
            details: { branchName },
          });
        }
      }

      const existing = new Map<string, string>();
      const conflicts: string[] = [];
      for (const branchName of branchNames) {
        const oid = await this.refOid(repository.canonicalPath, `refs/heads/${branchName}`);
        if (!oid) continue;
        existing.set(branchName, oid);
        if (oid !== baseline.oid) conflicts.push(branchName);
      }
      if (conflicts.length > 0) {
        throw new DomainError(
          'GIT_BRANCH_ALREADY_EXISTS',
          '部分同名本地分支已存在且指向不同提交，本次未创建任何分支',
          { httpStatus: 409, details: { branchNames: conflicts } },
        );
      }

      const results: CreateBranchResult[] = [];
      for (const branchName of branchNames) {
        if (existing.has(branchName)) {
          results.push({
            branchName,
            status: 'already_exists',
            message: '同名分支已指向所选基准，无需重复创建',
          });
          continue;
        }
        const result = await this.git.runWrite(
          repository.canonicalPath,
          ['branch', '--no-track', branchName, baseline.oid],
          { timeoutMs: 30_000, allowExitCodes: [0, 128] },
        );
        results.push(
          result.exitCode === 0
            ? { branchName, status: 'created', message: '创建成功' }
            : {
                branchName,
                status: 'failed',
                message: result.stderr || 'Git 未能创建该分支',
              },
        );
      }

      const created = results.filter((result) => result.status === 'created').length;
      const failed = results.filter((result) => result.status === 'failed').length;
      return {
        repositoryId: repository.id,
        baseline: { fullName: baseline.fullName, name: baseline.name, oid: baseline.oid },
        status: failed === 0 ? 'completed' : created > 0 ? 'partial_failed' : 'failed',
        summary: {
          total: results.length,
          created,
          alreadyExists: results.filter((result) => result.status === 'already_exists').length,
          failed,
        },
        results,
        error: null,
      };
    } finally {
      release();
    }
  }

  private async confirmedRepository(repositoryId: string): Promise<Repository> {
    const repository = await this.prisma.repository.findUnique({ where: { id: repositoryId } });
    if (!repository) throw new DomainError(errorCodes.notFound, '仓库不存在', { httpStatus: 404 });
    if (repository.whitelistStatus !== 'confirmed') {
      throw new DomainError('REPOSITORY_NOT_CONFIRMED', '只有已确认的仓库才能管理分支', {
        httpStatus: 409,
      });
    }
    await this.assertIdentity(repository);
    return repository;
  }

  private async assertIdentity(repository: Repository): Promise<void> {
    const identity = await this.inspector.inspect(repository.canonicalPath);
    if (!repositoryIdentityMatches(repository, identity)) {
      throw new DomainError('REPOSITORY_IDENTITY_CHANGED', '仓库身份已变化，必须重新确认', {
        httpStatus: 412,
        suggestedAction: 'reconfirm',
      });
    }
  }

  private async readBranches(cwd: string): Promise<GitBranchView[]> {
    const result = await this.git.runRead(cwd, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)%00%(HEAD)%00%(symref)',
      'refs/heads',
      'refs/remotes',
    ]);
    return result.stdout
      .toString('utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line): GitBranchView[] => {
        const [fullName = '', oid = '', updatedAt = '', subject = '', head = '', symref = ''] =
          line.split('\0');
        if (symref || !/^[0-9a-f]{40,64}$/u.test(oid)) return [];
        if (fullName.startsWith('refs/heads/')) {
          return [
            {
              name: fullName.slice('refs/heads/'.length),
              fullName,
              scope: 'local',
              remote: null,
              oid,
              updatedAt,
              subject,
              current: head.trim() === '*',
            },
          ];
        }
        if (!fullName.startsWith('refs/remotes/')) return [];
        const remoteBranch = fullName.slice('refs/remotes/'.length);
        const separator = remoteBranch.indexOf('/');
        if (separator < 1) return [];
        return [
          {
            name: remoteBranch,
            fullName,
            scope: 'remote',
            remote: remoteBranch.slice(0, separator),
            oid,
            updatedAt,
            subject,
            current: false,
          },
        ];
      })
      .sort((left, right) => {
        const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        return byTime || left.fullName.localeCompare(right.fullName);
      });
  }

  private async refOid(cwd: string, ref: string): Promise<string | null> {
    const result = await this.git.runRead(cwd, ['show-ref', '--verify', '--hash', ref], {
      allowExitCodes: [0, 1, 128],
    });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() || null : null;
  }
}
