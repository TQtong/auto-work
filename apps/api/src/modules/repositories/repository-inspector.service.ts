import { Inject, Injectable } from '@nestjs/common';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '@auto-work/contracts';
import { normalizeGitRemote, sha256 } from '@auto-work/domain';
import { APP_CONFIG, type AppConfig } from '../../config/config.module.js';
import { GitProcessService } from '../../infrastructure/git/git-process.service.js';
import type {
  GitStatusSnapshot,
  NormalizedRemoteObservation,
  RepositoryDiscoveryConfiguration,
  RepositoryIdentity,
} from './repository.types.js';

@Injectable()
export class RepositoryInspectorService {
  private readonly configuredRoot: string;
  private readonly configuredHostRoot: string;
  private readonly deploymentMode: 'native' | 'docker';

  public constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly git: GitProcessService,
  ) {
    this.configuredRoot = config.repositoryRoot;
    this.deploymentMode = config.deploymentMode ?? 'native';
    this.configuredHostRoot = config.repositoryHostPath ?? config.repositoryRoot;
  }

  public get repositoryRoot(): string {
    return this.configuredRoot;
  }

  /**
   * 返回扫描前即可展示的根目录状态，避免用户在空目录或错误挂载上反复点击扫描。
   * 这里只检查一级目录和 .git 标记，不执行 Git 命令，也不会登记任何仓库。
   */
  public async discoveryConfiguration(): Promise<RepositoryDiscoveryConfiguration> {
    const detectedAt = new Date().toISOString();
    const base = {
      deploymentMode: this.deploymentMode,
      configuredRoot: resolve(this.configuredRoot),
      hostRoot: this.configuredHostRoot,
      configurationKey:
        this.deploymentMode === 'docker'
          ? ('AUTO_WORK_REPOSITORY_PATH' as const)
          : ('AUTO_WORK_REPOSITORY_ROOT' as const),
      changeRequiresRestart: true,
      scanDepth: 1 as const,
      detectedAt,
    };

    try {
      const root = await realpath(this.configuredRoot);
      if (!(await stat(root)).isDirectory()) throw new Error('配置路径不是目录');
      const entries = await readdir(root, { withFileTypes: true });
      const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
      let gitCandidateCount = 0;
      for (const directory of directories) {
        const marker = await lstat(join(root, directory.name, '.git')).catch(() => null);
        if (marker?.isDirectory() || marker?.isFile()) gitCandidateCount += 1;
      }
      const skippedEntryCount = entries.length - directories.length;
      if (directories.length === 0) {
        return {
          ...base,
          accessible: true,
          status: 'empty',
          statusMessage: '扫描根目录可访问，但其中没有一级子目录',
          directoryCount: 0,
          gitCandidateCount: 0,
          skippedEntryCount,
        };
      }
      if (gitCandidateCount === 0) {
        return {
          ...base,
          accessible: true,
          status: 'no_git_candidates',
          statusMessage: '已找到一级子目录，但没有发现带 .git 标记的仓库候选',
          directoryCount: directories.length,
          gitCandidateCount: 0,
          skippedEntryCount,
        };
      }
      return {
        ...base,
        accessible: true,
        status: 'ready',
        statusMessage: `扫描目录就绪，发现 ${gitCandidateCount} 个一级 Git 仓库候选`,
        directoryCount: directories.length,
        gitCandidateCount,
        skippedEntryCount,
      };
    } catch {
      // 不向前端泄漏底层文件系统异常；详细失败会在真正扫描时转成稳定领域错误。
      return {
        ...base,
        accessible: false,
        status: 'unavailable',
        statusMessage: '扫描根目录不存在或当前进程无权访问',
        directoryCount: 0,
        gitCandidateCount: 0,
        skippedEntryCount: 0,
      };
    }
  }

  public async canonicalRoot(requestedRoot?: string): Promise<string> {
    const requested = requestedRoot ? resolve(requestedRoot) : resolve(this.configuredRoot);
    if (this.isUnsafeWindowsPath(requested)) {
      throw new DomainError('REPOSITORY_ROOT_UNSAFE', '仓库根目录不能是 UNC 或设备路径', {
        httpStatus: 422,
      });
    }
    if (requested.toLowerCase() !== resolve(this.configuredRoot).toLowerCase()) {
      throw new DomainError('REPOSITORY_ROOT_NOT_ALLOWED', '只能扫描配置允许的仓库根目录', {
        httpStatus: 403,
      });
    }
    const root = await realpath(requested).catch(() => {
      throw new DomainError('REPOSITORY_ROOT_UNAVAILABLE', '仓库根目录不存在或无权访问', {
        httpStatus: 422,
      });
    });
    if (!(await stat(root)).isDirectory()) {
      throw new DomainError('REPOSITORY_ROOT_NOT_DIRECTORY', '仓库根路径不是目录', {
        httpStatus: 422,
      });
    }
    return resolve(root);
  }

  public async inspect(candidatePath: string, rootPath?: string): Promise<RepositoryIdentity> {
    const root = rootPath ?? (await this.canonicalRoot());
    const candidate = resolve(await realpath(candidatePath));
    this.assertDirectChild(root, candidate);
    const gitMarker = resolve(candidate, '.git');
    const markerStat = await lstat(gitMarker).catch(() => null);
    if (!markerStat || (!markerStat.isDirectory() && !markerStat.isFile())) {
      throw new DomainError('NOT_A_GIT_REPOSITORY', '目录不包含受支持的 Git 元数据', {
        httpStatus: 422,
      });
    }
    const gitDirKind = markerStat.isFile() ? 'worktree' : 'normal';
    const [topLevelResult, gitDirectoryResult, bareResult] = await Promise.all([
      this.git.runRead(candidate, ['rev-parse', '--show-toplevel']),
      this.git.runRead(candidate, ['rev-parse', '--absolute-git-dir']),
      this.git.runRead(candidate, ['rev-parse', '--is-bare-repository']),
    ]);
    if (bareResult.stdout.toString('utf8').trim() === 'true') {
      throw new DomainError('BARE_REPOSITORY_UNSUPPORTED', '首版不登记 bare 仓库', {
        httpStatus: 422,
      });
    }
    const topLevel = resolve(await realpath(topLevelResult.stdout.toString('utf8').trim()));
    if (topLevel.toLowerCase() !== candidate.toLowerCase()) {
      throw new DomainError('REPOSITORY_TOPLEVEL_MISMATCH', '候选目录不是仓库顶层', {
        httpStatus: 422,
      });
    }
    const gitDirectory = resolve(await realpath(gitDirectoryResult.stdout.toString('utf8').trim()));
    const gitDirectoryRelative = relative(root, gitDirectory);
    if (
      gitDirectoryRelative.startsWith(`..${sep}`) ||
      gitDirectoryRelative === '..' ||
      isAbsolute(gitDirectoryRelative)
    ) {
      throw new DomainError('GIT_DIRECTORY_OUTSIDE_ROOT', 'Git 元数据目录逃逸出允许根目录', {
        httpStatus: 403,
      });
    }
    const gitDirectoryStat = await stat(gitDirectory);
    const [headResult, branchResult, remotes] = await Promise.all([
      this.git.runRead(candidate, ['rev-parse', '--verify', 'HEAD'], { allowExitCodes: [0, 128] }),
      this.git.runRead(candidate, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        allowExitCodes: [0, 1, 128],
      }),
      this.readRemotes(candidate),
    ]);
    const headSha = headResult.stdout.toString('utf8').trim() || null;
    const branchName = branchResult.stdout.toString('utf8').trim() || null;
    const defaultRemote = remotes.find((remote) => remote.name === 'origin') ?? remotes[0] ?? null;
    return {
      canonicalPath: candidate,
      realPathHash: sha256(candidate.toLowerCase()),
      identityHash: sha256(
        `${gitDirectory.toLowerCase()}\0${gitDirectoryStat.dev}\0${gitDirectoryStat.ino}\0${gitDirectoryStat.birthtimeMs}`,
      ),
      displayName: basename(candidate),
      gitDirKind,
      headSha,
      branchName,
      unborn: !headSha,
      defaultRemote,
      remotes,
    };
  }

  public async collectStatus(repositoryPath: string): Promise<GitStatusSnapshot> {
    const root = await this.canonicalRoot();
    const identity = await this.inspect(repositoryPath, root);
    const [statusResult, stashResult, recentCommitResult] = await Promise.all([
      this.git.runRead(identity.canonicalPath, [
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ]),
      this.git.runRead(identity.canonicalPath, ['stash', 'list', '--format=%H'], {
        allowExitCodes: [0],
      }),
      this.git.runRead(
        identity.canonicalPath,
        ['log', '-1', '--format=%H%x00%an%x00%ae%x00%aI%x00%s'],
        { allowExitCodes: [0, 128] },
      ),
    ]);
    const parsed = this.parsePorcelainV2(statusResult.stdout);
    const commitFields = recentCommitResult.stdout
      .toString('utf8')
      .replace(/\r?\n$/u, '')
      .split('\0');
    const recentCommit = commitFields[0]
      ? {
          sha: commitFields[0],
          authorName: commitFields[1] ?? '',
          authorEmail: commitFields[2] ?? '',
          committedAt: commitFields[3] ?? '',
          title: commitFields[4] ?? '',
        }
      : null;
    return {
      ...parsed,
      stashCount: stashResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean).length,
      recentCommit,
      remotes: identity.remotes,
    };
  }

  private async readRemotes(repositoryPath: string): Promise<NormalizedRemoteObservation[]> {
    const namesResult = await this.git.runRead(repositoryPath, ['remote']);
    const names = namesResult.stdout
      .toString('utf8')
      .split(/\r?\n/u)
      .filter((name) => /^[a-z0-9][a-z0-9._/-]{0,100}$/iu.test(name) && !name.includes('..'));
    const observations: NormalizedRemoteObservation[] = [];
    for (const name of names.slice(0, 50)) {
      const urlResult = await this.git.runRead(repositoryPath, [
        'remote',
        'get-url',
        '--all',
        name,
      ]);
      const firstUrl = urlResult.stdout.toString('utf8').split(/\r?\n/u).find(Boolean) ?? '';
      const normalized = normalizeGitRemote(firstUrl);
      observations.push({
        name,
        sanitizedUrl: normalized?.sanitizedUrl ?? null,
        protocol: normalized?.protocol ?? null,
        host: normalized?.host ?? null,
        port: normalized?.port ?? null,
        path: normalized?.path ?? null,
      });
    }
    return observations;
  }

  private parsePorcelainV2(
    output: Buffer,
  ): Omit<GitStatusSnapshot, 'stashCount' | 'recentCommit' | 'remotes'> {
    const records = output.toString('utf8').split('\0');
    const result = {
      headSha: null as string | null,
      branchName: null as string | null,
      detached: false,
      unborn: false,
      upstreamRef: null as string | null,
      aheadCount: 0,
      behindCount: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      pathSummary: [] as Array<{ path: string; previousPath?: string; state: string }>,
    };
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (record.startsWith('# branch.oid ')) {
        const value = record.slice(13);
        result.unborn = value === '(initial)';
        result.headSha = result.unborn ? null : value;
      } else if (record.startsWith('# branch.head ')) {
        const value = record.slice(14);
        result.detached = value === '(detached)';
        result.branchName = result.detached ? null : value;
      } else if (record.startsWith('# branch.upstream ')) {
        result.upstreamRef = record.slice(18);
      } else if (record.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
        result.aheadCount = Number(match?.[1] ?? 0);
        result.behindCount = Number(match?.[2] ?? 0);
      } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
        const state = record.slice(2, 4);
        if (state[0] !== '.') result.stagedCount += 1;
        if (state[1] !== '.') result.unstagedCount += 1;
        const spaceCount = record.startsWith('2 ') ? 9 : 8;
        const path = this.afterSpaces(record, spaceCount);
        const previousPath = record.startsWith('2 ') ? records[index + 1] : undefined;
        if (previousPath !== undefined) index += 1;
        if (result.pathSummary.length < 200) {
          result.pathSummary.push({ path, ...(previousPath ? { previousPath } : {}), state });
        }
      } else if (record.startsWith('u ')) {
        result.conflictedCount += 1;
        const path = this.afterSpaces(record, 10);
        if (result.pathSummary.length < 200) result.pathSummary.push({ path, state: 'conflicted' });
      } else if (record.startsWith('? ')) {
        result.untrackedCount += 1;
        if (result.pathSummary.length < 200)
          result.pathSummary.push({ path: record.slice(2), state: 'untracked' });
      }
    }
    return result;
  }

  private afterSpaces(value: string, count: number): string {
    let offset = -1;
    for (let index = 0; index < count; index += 1) offset = value.indexOf(' ', offset + 1);
    return offset >= 0 ? value.slice(offset + 1) : '';
  }

  private assertDirectChild(rootPath: string, candidatePath: string): void {
    const child = relative(resolve(rootPath), resolve(candidatePath));
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === '..' ||
      isAbsolute(child) ||
      child.includes(sep)
    ) {
      throw new DomainError('REPOSITORY_PATH_OUTSIDE_ROOT', '仓库必须是允许根目录的一级子目录', {
        httpStatus: 403,
      });
    }
  }

  private isUnsafeWindowsPath(value: string): boolean {
    return value.startsWith('\\\\') || value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\');
  }
}
