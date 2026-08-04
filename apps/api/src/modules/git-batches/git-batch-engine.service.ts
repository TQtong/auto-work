import { Injectable } from '@nestjs/common';
import type { Repository } from '@prisma/client';
import {
  DomainError,
  type GitBatchAction,
  type GitBatchBlockReason,
  type GitBatchWarning,
} from '@auto-work/contracts';
import {
  assertAllowedGitAction,
  assertSafeRefName,
  assertSafeRemoteName,
  assertSafeRepositoryPath,
  requestHash,
  sha256,
} from '@auto-work/domain';
import { GitProcessService } from '../../infrastructure/git/git-process.service.js';
import {
  repositoryIdentityMatches,
  RepositoryInspectorService,
} from '../repositories/repository-inspector.service.js';
import type {
  GitExecutionResult,
  GitItemPreview,
  GitOperationSnapshot,
} from './git-batch.types.js';

type Parameters = Record<string, unknown>;

interface PlannedCommand {
  args: string[];
  display: string;
  expectedChanges: string[];
  warnings: GitBatchWarning[];
  blocks: GitBatchBlockReason[];
  facts: Record<string, unknown>;
  alreadySatisfied: boolean;
  riskLevel: GitItemPreview['riskLevel'];
}

@Injectable()
export class GitBatchEngineService {
  public constructor(
    private readonly git: GitProcessService,
    private readonly inspector: RepositoryInspectorService,
  ) {}

  public async preview(
    repository: Repository,
    actionValue: string,
    parameters: Parameters,
  ): Promise<GitItemPreview> {
    assertAllowedGitAction(actionValue);
    const { snapshot, plan } = await this.plan(repository, actionValue, parameters);
    const snapshotHash = requestHash({ action: actionValue, parameters, snapshot });
    return {
      snapshot,
      snapshotHash,
      displayCommand: plan.display,
      expectedChanges: plan.expectedChanges,
      warnings: plan.warnings,
      blockingReasons: plan.blocks,
      riskLevel: plan.riskLevel,
      executable: plan.blocks.length === 0,
      alreadySatisfied: plan.alreadySatisfied,
    };
  }

  public async execute(
    repository: Repository,
    actionValue: string,
    parameters: Parameters,
    expectedSnapshotHash: string,
  ): Promise<GitExecutionResult> {
    assertAllowedGitAction(actionValue);
    const startedAt = Date.now();
    const { snapshot, plan } = await this.plan(repository, actionValue, parameters);
    const actualHash = requestHash({ action: actionValue, parameters, snapshot });
    if (actualHash !== expectedSnapshotHash) {
      return {
        resultCode: 'stale_preview',
        summary: '仓库状态已变化，未执行任何写操作；请重新预览',
        exitCode: null,
        postHeadSha: snapshot.headSha,
        outputSummary: '',
        durationMs: Date.now() - startedAt,
      };
    }
    if (plan.blocks.length > 0) {
      return {
        resultCode: 'blocked',
        summary: '执行前复核发现阻断条件，未执行写操作',
        exitCode: null,
        postHeadSha: snapshot.headSha,
        outputSummary: plan.blocks.map((item) => item.message).join('；'),
        durationMs: Date.now() - startedAt,
      };
    }
    if (plan.alreadySatisfied) {
      return {
        resultCode: 'already_satisfied',
        summary: '目标状态已满足，无需执行写操作',
        exitCode: 0,
        postHeadSha: snapshot.headSha,
        outputSummary: '',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const result = await this.git.runWrite(repository.canonicalPath, plan.args, {
        timeoutMs: this.timeoutFor(actionValue),
        outputLimit: 2 * 1024 * 1024,
        allowExitCodes: [0, 1, 128],
      });
      const postStatus = await this.inspector.collectStatus(repository.canonicalPath);
      const output = this.safeOutput(`${result.stdout.toString('utf8')}\n${result.stderr}`);
      if (result.exitCode !== 0) {
        const needsReview = actionValue === 'stash_apply' && postStatus.conflictedCount > 0;
        return {
          resultCode: needsReview ? 'needs_review' : 'failed',
          summary: needsReview
            ? '应用 stash 产生冲突，已保留 stash，必须人工处理工作区'
            : 'Git 命令返回失败，其他仓库仍会继续执行',
          exitCode: result.exitCode,
          postHeadSha: postStatus.headSha,
          outputSummary: output,
          durationMs: result.durationMs,
        };
      }
      return {
        resultCode: 'succeeded',
        summary: this.successSummary(actionValue),
        exitCode: result.exitCode,
        postHeadSha: postStatus.headSha,
        outputSummary: output,
        durationMs: result.durationMs,
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'GIT_WRITE_TIMEOUT') {
        return {
          resultCode: 'needs_review',
          summary: 'Git 写命令超时，无法安全判断最终状态，必须人工复核',
          exitCode: null,
          postHeadSha: null,
          outputSummary: '',
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    }
  }

  private async plan(
    repository: Repository,
    action: GitBatchAction,
    parameters: Parameters,
  ): Promise<{ snapshot: GitOperationSnapshot; plan: PlannedCommand }> {
    if (repository.whitelistStatus !== 'confirmed') {
      throw new DomainError('REPOSITORY_NOT_CONFIRMED', '仓库不在用户已确认的写白名单中', {
        httpStatus: 409,
      });
    }
    const identity = await this.inspector.inspect(repository.canonicalPath);
    if (!repositoryIdentityMatches(repository, identity)) {
      throw new DomainError('REPOSITORY_IDENTITY_CHANGED', '仓库身份已变化，必须重新确认', {
        httpStatus: 412,
        suggestedAction: 'reconfirm',
      });
    }
    const status = await this.inspector.collectStatus(repository.canonicalPath);
    const indexResult = await this.git.runRead(repository.canonicalPath, [
      'ls-files',
      '--stage',
      '-z',
    ]);
    const plan = await this.planAction(repository.canonicalPath, action, parameters, status);
    return {
      snapshot: {
        repositoryIdentityHash: identity.identityHash,
        headSha: status.headSha,
        branchName: status.branchName,
        detached: status.detached,
        unborn: status.unborn,
        upstreamRef: status.upstreamRef,
        aheadCount: status.aheadCount,
        behindCount: status.behindCount,
        stagedCount: status.stagedCount,
        unstagedCount: status.unstagedCount,
        untrackedCount: status.untrackedCount,
        conflictedCount: status.conflictedCount,
        pathSummary: status.pathSummary,
        // 直接哈希 index 条目，不调用 write-tree，保证预览阶段不会向对象库写入对象。
        indexTree: sha256(indexResult.stdout),
        actionFacts: plan.facts,
      },
      plan,
    };
  }

  private async planAction(
    cwd: string,
    action: GitBatchAction,
    parameters: Parameters,
    status: Awaited<ReturnType<RepositoryInspectorService['collectStatus']>>,
  ): Promise<PlannedCommand> {
    const warnings: GitBatchWarning[] = [];
    const blocks: GitBatchBlockReason[] = [];
    const facts: Record<string, unknown> = {};
    const block = (code: string, message: string, recovery: string) => {
      blocks.push({ code, message, recovery });
    };
    let args: string[] = [];
    let expectedChanges: string[] = [];
    let alreadySatisfied = false;
    let riskLevel: PlannedCommand['riskLevel'] = 'information';

    if (status.conflictedCount > 0 && !['stage_paths', 'commit'].includes(action)) {
      block('GIT_CONFLICT_PRESENT', '仓库存在未解决冲突', '先人工解决冲突并重新预览');
    }

    switch (action) {
      case 'fetch_prune': {
        const remote = assertSafeRemoteName(this.stringParameter(parameters, 'remote'));
        await this.assertRemoteExists(cwd, remote, block);
        args = ['fetch', remote, '--prune'];
        expectedChanges = ['更新远端跟踪引用', '清理远端已删除分支的跟踪引用'];
        facts.remote = remote;
        break;
      }
      case 'pull_ff_only': {
        if (status.detached || !status.branchName) {
          block(
            'GIT_BRANCH_REQUIRED',
            '分离 HEAD 或未出生分支不能执行拉取',
            '切换到有上游的本地分支后重试',
          );
        }
        if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0) {
          block(
            'GIT_WORKTREE_NOT_CLEAN',
            '工作区或暂存区存在变更，快进拉取可能覆盖相关文件',
            '先提交、stash 或清理变更后重新预览',
          );
        }
        const explicitRemote = this.optionalStringParameter(parameters, 'remote');
        const explicitBranch = this.optionalStringParameter(parameters, 'branch');
        if ((explicitRemote && !explicitBranch) || (!explicitRemote && explicitBranch)) {
          block(
            'GIT_PULL_TARGET_INCOMPLETE',
            '显式拉取目标必须同时提供远端与分支',
            '同时选择远端和分支，或使用当前上游',
          );
        }
        const target =
          explicitRemote && explicitBranch
            ? {
                remote: assertSafeRemoteName(explicitRemote),
                branch: await this.validRef(cwd, explicitBranch),
              }
            : this.upstreamParts(status.upstreamRef);
        if (!target) {
          block('GIT_UPSTREAM_MISSING', '当前分支没有可验证的上游', '先设置上游并重新预览');
          args = ['pull', '--ff-only'];
          break;
        }
        await this.assertRemoteExists(cwd, target.remote, block);
        const trackingOid = await this.refOid(
          cwd,
          `refs/remotes/${target.remote}/${target.branch}`,
        );
        const liveRemote = await this.remoteHeadOid(cwd, target.remote, target.branch);
        const remoteOid = liveRemote.known ? liveRemote.oid : trackingOid;
        facts.remote = target.remote;
        facts.branch = target.branch;
        facts.remoteOid = remoteOid;
        if (!liveRemote.known) {
          block(
            'GIT_REMOTE_STATE_UNKNOWN',
            '无法读取远端分支状态，禁止依据过期缓存执行拉取',
            '检查远端连接并重新预览',
          );
        } else if (trackingOid !== liveRemote.oid) {
          block(
            'GIT_REMOTE_TRACKING_STALE',
            '远端分支已变化，本地跟踪引用不是最新状态',
            '先执行 fetch --prune 后重新预览',
          );
        } else if (!remoteOid || !status.headSha) {
          block(
            'GIT_REMOTE_STATE_UNKNOWN',
            '缺少目标远端跟踪引用，无法判断是否可快进',
            '先执行 fetch --prune 后重新预览',
          );
        } else if (remoteOid === status.headSha) {
          alreadySatisfied = true;
        } else if (!(await this.isAncestor(cwd, status.headSha, remoteOid))) {
          if (await this.isAncestor(cwd, remoteOid, status.headSha)) alreadySatisfied = true;
          else
            block(
              'GIT_NON_FAST_FORWARD',
              '本地与远端历史已分叉，禁止自动合并或变基',
              '人工选择合并策略并完成后重新预览',
            );
        }
        args = explicitRemote
          ? ['pull', '--ff-only', target.remote, target.branch]
          : ['pull', '--ff-only'];
        expectedChanges = alreadySatisfied ? [] : ['仅以 fast-forward 更新当前分支与工作区'];
        riskLevel = 'warning';
        break;
      }
      case 'create_branch': {
        const branch = await this.validRef(cwd, this.stringParameter(parameters, 'branch'));
        const baseline = assertSafeRefName(this.stringParameter(parameters, 'baseline'), '基线');
        const baselineOid = await this.commitOid(cwd, baseline);
        if (!baselineOid)
          block('GIT_BASELINE_NOT_FOUND', '基线不能解析为现有提交', '选择已存在且可解析的基线');
        // 创建分支动作按详细设计同时切换工作区，因此沿用 checkout 的脏工作区保护边界。
        if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0) {
          block(
            'GIT_CREATE_BRANCH_WOULD_RISK_CHANGES',
            '工作区或暂存区不干净，创建后切换可能覆盖修改',
            '先提交或显式 stash 后重新预览',
          );
        }
        const existingOid = await this.refOid(cwd, `refs/heads/${branch}`);
        if (existingOid) {
          if (existingOid !== baselineOid)
            block(
              'GIT_BRANCH_EXISTS',
              '同名分支已存在且指向不同提交，禁止覆盖',
              '选择其他分支名或人工确认现有分支',
            );
        }
        facts.branch = branch;
        facts.baselineOid = baselineOid;
        facts.existingOid = existingOid;
        alreadySatisfied =
          existingOid === baselineOid && status.branchName === branch && !status.detached;
        // 同名分支已精确指向预检基线时只做安全切换；不存在时用固定参数一次创建并切换。
        args = existingOid
          ? ['checkout', branch]
          : ['checkout', '-b', branch, baselineOid ?? baseline];
        expectedChanges = alreadySatisfied
          ? []
          : existingOid
            ? [`切换工作区到已指向预检基线的本地分支 ${branch}`]
            : [`从已解析基线创建本地分支 ${branch}`, `切换工作区到本地分支 ${branch}`];
        riskLevel = 'warning';
        break;
      }
      case 'checkout': {
        const branch = await this.validRef(cwd, this.stringParameter(parameters, 'targetBranch'));
        const branchOid = await this.refOid(cwd, `refs/heads/${branch}`);
        if (!branchOid) block('GIT_BRANCH_NOT_FOUND', '目标本地分支不存在', '先创建或获取目标分支');
        if (status.stagedCount + status.unstagedCount + status.untrackedCount > 0) {
          block(
            'GIT_CHECKOUT_WOULD_RISK_CHANGES',
            '工作区或暂存区不干净，禁止自动切换',
            '先提交或显式 stash 后重新预览',
          );
        }
        alreadySatisfied = status.branchName === branch && !status.detached;
        facts.targetBranch = branch;
        facts.targetOid = branchOid;
        args = ['checkout', branch];
        expectedChanges = alreadySatisfied ? [] : [`切换工作区到本地分支 ${branch}`];
        riskLevel = 'warning';
        break;
      }
      case 'push_set_upstream':
      case 'push': {
        const remote = assertSafeRemoteName(this.stringParameter(parameters, 'remote'));
        const branch = await this.validRef(cwd, this.stringParameter(parameters, 'branch'));
        await this.assertRemoteExists(cwd, remote, block);
        const localOid = await this.refOid(cwd, `refs/heads/${branch}`);
        const trackingOid = await this.refOid(cwd, `refs/remotes/${remote}/${branch}`);
        const liveRemote = await this.remoteHeadOid(cwd, remote, branch);
        const remoteOid = liveRemote.known ? liveRemote.oid : trackingOid;
        if (!localOid)
          block('GIT_LOCAL_BRANCH_NOT_FOUND', '待推送的本地分支不存在', '选择已存在的本地分支');
        if (!liveRemote.known) {
          block(
            'GIT_REMOTE_STATE_UNKNOWN',
            '无法读取远端分支状态，禁止推送',
            '检查远端连接并重新预览',
          );
        } else if (!remoteOid && action === 'push') {
          block(
            'GIT_UPSTREAM_REQUIRED',
            '远端分支尚不存在，首次推送必须使用设置上游动作',
            '改用 push_set_upstream 重新预览',
          );
        } else if (trackingOid !== remoteOid && remoteOid) {
          block(
            'GIT_REMOTE_TRACKING_STALE',
            '远端分支已变化，本地跟踪引用不是最新状态',
            '先执行 fetch --prune 后重新预览',
          );
        } else if (localOid === remoteOid) {
          alreadySatisfied = true;
        } else if (remoteOid && localOid && !(await this.isAncestor(cwd, remoteOid, localOid))) {
          block(
            'GIT_PUSH_NOT_FAST_FORWARD',
            '远端包含本地没有的提交，禁止强制推送',
            '先获取并人工整合远端提交',
          );
        }
        facts.remote = remote;
        facts.branch = branch;
        facts.localOid = localOid;
        facts.remoteOid = remoteOid;
        const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
        args =
          action === 'push_set_upstream'
            ? ['push', '--set-upstream', remote, refspec]
            : ['push', remote, refspec];
        expectedChanges = alreadySatisfied ? [] : [`将 ${branch} 的普通快进更新推送到 ${remote}`];
        warnings.push({
          id: 'remote-write',
          severity: 'warning',
          message: '此动作会修改远端仓库引用，且不会使用 force 变体',
        });
        riskLevel = 'sensitive';
        break;
      }
      case 'stash_create': {
        const message = this.stringParameter(parameters, 'message').trim();
        if (!message)
          block('GIT_STASH_MESSAGE_REQUIRED', 'stash 说明不能为空', '填写可识别的 stash 说明');
        const includeUntracked = parameters.includeUntracked === true;
        const changeCount =
          status.stagedCount +
          status.unstagedCount +
          (includeUntracked ? status.untrackedCount : 0);
        alreadySatisfied = changeCount === 0;
        args = [
          'stash',
          'push',
          ...(includeUntracked ? ['--include-untracked'] : []),
          '-m',
          message,
        ];
        facts.changeCount = changeCount;
        facts.includeUntracked = includeUntracked;
        expectedChanges = alreadySatisfied
          ? []
          : ['创建新的 stash，随后恢复受影响文件到 HEAD 状态'];
        warnings.push({
          id: 'worktree-rewrite',
          severity: 'warning',
          message: 'stash 会改写当前工作区和暂存区',
        });
        riskLevel = 'warning';
        break;
      }
      case 'stash_apply': {
        const stashOid = this.stringParameter(parameters, 'stashOid');
        if (!/^[0-9a-f]{40,64}$/u.test(stashOid) || !(await this.commitOid(cwd, stashOid))) {
          block(
            'GIT_STASH_NOT_FOUND',
            '指定 stash OID 不能解析为现有提交',
            '刷新 stash 列表并重新选择',
          );
        }
        const pathsResult = await this.git.runRead(
          cwd,
          ['diff-tree', '--no-commit-id', '--name-only', '-r', stashOid],
          { allowExitCodes: [0, 128] },
        );
        const stashPaths = pathsResult.stdout
          .toString('utf8')
          .split(/\r?\n/u)
          .filter(Boolean)
          .slice(0, 200);
        facts.stashOid = stashOid;
        facts.stashPaths = stashPaths;
        args = ['stash', 'apply', stashOid];
        expectedChanges = [
          `将 stash 中的 ${stashPaths.length} 个已跟踪路径应用到工作区`,
          '不会自动 drop stash',
        ];
        warnings.push({
          id: 'stash-conflict',
          severity: 'warning',
          message: '应用 stash 可能产生冲突；冲突时批次会进入待人工复核',
        });
        riskLevel = 'sensitive';
        break;
      }
      case 'stage_paths': {
        const requested = this.arrayParameter(parameters, 'paths').map(assertSafeRepositoryPath);
        const paths = [...new Set(requested)].sort();
        const visiblePaths = new Set(
          status.pathSummary.flatMap((item) =>
            [item.path, item.previousPath].filter((value): value is string => Boolean(value)),
          ),
        );
        for (const path of paths) {
          if (!visiblePaths.has(path))
            block(
              'GIT_PATH_NOT_CHANGED',
              `路径 ${path} 不在预览时的变更集合中`,
              '刷新状态并只选择明确展示的变更路径',
            );
        }
        facts.paths = paths;
        args = ['add', '--', ...paths];
        expectedChanges = paths.map((path) => `仅暂存：${path}`);
        riskLevel = 'warning';
        break;
      }
      case 'commit': {
        const message = this.stringParameter(parameters, 'message').trim();
        if (!message) block('GIT_COMMIT_MESSAGE_REQUIRED', '提交说明不能为空', '填写提交说明');
        if (status.stagedCount === 0)
          block('GIT_INDEX_EMPTY', '暂存区没有可提交变更', '先通过明确路径暂存变更');
        if (status.conflictedCount > 0)
          block('GIT_INDEX_CONFLICTED', '暂存区仍包含冲突项', '先解决并暂存所有冲突');
        facts.expectedStagedCount = status.stagedCount;
        args = ['commit', '-m', message];
        expectedChanges = [
          `使用当前已复核的 ${status.stagedCount} 个暂存变更创建提交`,
          '正常运行仓库 hooks，不使用 --no-verify',
        ];
        warnings.push({
          id: 'create-commit',
          severity: 'warning',
          message: '此动作会创建不可自动撤销的本地提交',
        });
        riskLevel = 'sensitive';
        break;
      }
    }

    return {
      args,
      display: this.displayCommand(args),
      expectedChanges,
      warnings,
      blocks,
      facts,
      alreadySatisfied,
      riskLevel,
    };
  }

  private async assertRemoteExists(
    cwd: string,
    remote: string,
    block: (code: string, message: string, recovery: string) => void,
  ): Promise<void> {
    const result = await this.git.runRead(cwd, ['remote', 'get-url', remote], {
      allowExitCodes: [0, 2, 128],
    });
    if (result.exitCode !== 0)
      block('GIT_REMOTE_NOT_FOUND', `远端 ${remote} 不存在`, '刷新仓库远端并重新选择');
  }

  private async validRef(cwd: string, value: string): Promise<string> {
    const safe = assertSafeRefName(value);
    const result = await this.git.runRead(cwd, ['check-ref-format', '--branch', safe], {
      allowExitCodes: [0, 128],
    });
    if (result.exitCode !== 0)
      throw new DomainError('GIT_REF_INVALID', 'Git 拒绝该分支名称', { httpStatus: 422 });
    return safe;
  }

  private async refOid(cwd: string, ref: string): Promise<string | null> {
    const result = await this.git.runRead(cwd, ['show-ref', '--verify', '--hash', ref], {
      allowExitCodes: [0, 1, 128],
    });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() || null : null;
  }

  private async commitOid(cwd: string, ref: string): Promise<string | null> {
    const result = await this.git.runRead(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], {
      allowExitCodes: [0, 128],
    });
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() || null : null;
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git.runRead(
      cwd,
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { allowExitCodes: [0, 1, 128] },
    );
    return result.exitCode === 0;
  }

  private async remoteHeadOid(
    cwd: string,
    remote: string,
    branch: string,
  ): Promise<{ known: boolean; oid: string | null }> {
    const result = await this.git.runRead(
      cwd,
      ['ls-remote', '--heads', remote, `refs/heads/${branch}`],
      { timeoutMs: 30_000, allowExitCodes: [0, 128] },
    );
    if (result.exitCode !== 0) return { known: false, oid: null };
    const oid = result.stdout.toString('utf8').trim().split(/\s/u)[0] ?? '';
    return { known: true, oid: /^[0-9a-f]{40,64}$/u.test(oid) ? oid : null };
  }

  private upstreamParts(value: string | null): { remote: string; branch: string } | null {
    if (!value) return null;
    const slash = value.indexOf('/');
    if (slash < 1 || slash === value.length - 1) return null;
    return {
      remote: assertSafeRemoteName(value.slice(0, slash)),
      branch: assertSafeRefName(value.slice(slash + 1)),
    };
  }

  private stringParameter(parameters: Parameters, key: string): string {
    const value = parameters[key];
    if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
      throw new DomainError('GIT_PARAMETER_INVALID', `Git 动作参数 ${key} 无效`, {
        httpStatus: 422,
      });
    }
    return value;
  }

  private optionalStringParameter(parameters: Parameters, key: string): string | null {
    const value = parameters[key];
    return value === undefined ? null : this.stringParameter(parameters, key);
  }

  private arrayParameter(parameters: Parameters, key: string): string[] {
    const value = parameters[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new DomainError('GIT_PARAMETER_INVALID', `Git 动作参数 ${key} 无效`, {
        httpStatus: 422,
      });
    }
    return value;
  }

  private displayCommand(args: readonly string[]): string {
    return `git ${args.map((value) => (/^[A-Za-z0-9._/:=-]+$/u.test(value) ? value : JSON.stringify(value))).join(' ')}`;
  }

  private safeOutput(value: string): string {
    return value
      .replace(
        /(?:Bearer|PRIVATE-TOKEN|token|secret|password|oauth2)\s*[:=]?\s*\S+/giu,
        '[REDACTED]',
      )
      .trim()
      .slice(0, 8_000);
  }

  private timeoutFor(action: GitBatchAction): number {
    return ['fetch_prune', 'pull_ff_only', 'push', 'push_set_upstream'].includes(action)
      ? 120_000
      : 30_000;
  }

  private successSummary(action: GitBatchAction): string {
    const summaries: Record<GitBatchAction, string> = {
      fetch_prune: '远端跟踪引用已安全更新并完成 prune',
      pull_ff_only: '当前分支已通过 fast-forward 更新',
      create_branch: '本地分支已从预览时解析的基线创建并完成工作区切换',
      checkout: '工作区已切换到目标本地分支',
      push_set_upstream: '分支已普通推送并设置上游',
      push: '分支已完成普通快进推送',
      stash_create: '已创建 stash 并更新工作区',
      stash_apply: 'stash 已应用且未自动删除',
      stage_paths: '仅预览中批准的明确路径已暂存',
      commit: '已使用预览时复核的暂存内容创建提交',
    };
    return summaries[action];
  }
}
