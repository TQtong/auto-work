import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestHash } from '@auto-work/domain';
import type { AppConfig } from '../src/config/config.module.js';
import type { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { GitProcessService } from '../src/infrastructure/git/git-process.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { GitBatchEngineService } from '../src/modules/git-batches/git-batch-engine.service.js';
import { GitBatchHandlers } from '../src/modules/git-batches/git-batch.handlers.js';
import { GitBatchService } from '../src/modules/git-batches/git-batch.service.js';
import { RepositoryWriteLockService } from '../src/modules/git-batches/repository-write-lock.service.js';
import { IdempotencyService } from '../src/modules/idempotency/idempotency.service.js';
import type { JobExecutionContext } from '../src/modules/jobs/job-registry.service.js';
import { JobRegistryService } from '../src/modules/jobs/job-registry.service.js';
import { RepositoryInspectorService } from '../src/modules/repositories/repository-inspector.service.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git.exe', args, { cwd, windowsHide: true, stdio: 'ignore' });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git.exe', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git.exe', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === 'win32')('Git 批次持久化工作流', () => {
  let temporaryDirectory = '';
  let repositoryRoot = '';
  let prisma: PrismaClient;
  let batches: GitBatchService;
  let registry: JobRegistryService;
  const repositoryPaths: string[] = [];

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-git-workflow-'));
    repositoryRoot = join(temporaryDirectory, 'repositories');
    await mkdir(repositoryRoot);
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(temporaryDirectory, 'workflow.db').replaceAll('\\', '/')}`,
    });
    const migrationRoot = resolve('prisma/migrations');
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
      for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
        if (statement) await prisma.$executeRawUnsafe(statement);
      }
    }

    const config: AppConfig = {
      host: '127.0.0.1',
      port: 3760,
      dataDir: join(temporaryDirectory, 'data'),
      webDist: join(temporaryDirectory, 'web'),
      databaseUrl: `file:${join(temporaryDirectory, 'workflow.db').replaceAll('\\', '/')}`,
      repositoryRoot,
      logLevel: 'info',
      environment: 'test',
    };
    const gitProcess = new GitProcessService();
    const inspector = new RepositoryInspectorService(config, gitProcess);
    for (let index = 0; index < 14; index += 1) {
      const path = join(repositoryRoot, `仓库 ${String(index + 1).padStart(2, '0')}`);
      repositoryPaths.push(path);
      await mkdir(path);
      git(path, ['init', '-b', 'main']);
      git(path, ['config', 'user.name', '批次测试']);
      git(path, ['config', 'user.email', 'batch@example.com']);
      await writeFile(join(path, 'README.md'), `仓库 ${index + 1}\n`, 'utf8');
      git(path, ['add', '--', 'README.md']);
      git(path, ['commit', '-m', '初始化']);
      const identity = await inspector.inspect(path);
      await prisma.repository.create({
        data: {
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          canonicalPath: identity.canonicalPath,
          realPathHash: identity.realPathHash,
          identityHash: identity.identityHash,
          displayName: identity.displayName,
          gitDirKind: identity.gitDirKind,
          baselineBranch: 'main',
          whitelistStatus: 'confirmed',
        },
      });
    }

    const prismaService = prisma as unknown as PrismaService;
    batches = new GitBatchService(prismaService);
    registry = new JobRegistryService();
    const engine = new GitBatchEngineService(gitProcess, inspector);
    const audit = new AuditService(prismaService);
    const handlers = new GitBatchHandlers(
      registry,
      prismaService,
      batches,
      engine,
      new RepositoryWriteLockService(),
      audit,
    );
    handlers.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    // 测试目录来自本用例的 mkdtemp，清理边界明确且不包含任何真实仓库。
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('14 个仓库中 2 个快照过期时，12 个成功且批次精确进入 partial_failed', async () => {
    const repositoryIds = (
      await prisma.repository.findMany({ orderBy: { displayName: 'asc' }, select: { id: true } })
    ).map((item) => item.id);
    const created = await batches.createPreview(
      {
        action: 'create_branch',
        repositoryIds,
        parameters: { branch: '批次/完整验证', baseline: 'main' },
      },
      'local-user',
    );
    await registry.get('git.batch.preview')!.execute(context(created.operationId, created.batchId));
    const previewed = await batches.get(created.batchId);
    expect(previewed.status).toBe('previewed');
    expect(previewed.items).toHaveLength(14);
    expect(previewed.items.every((item) => item.executable)).toBe(true);

    for (const path of repositoryPaths.slice(0, 2)) {
      await writeFile(join(path, '预览后变化.txt'), '使快照过期\n', 'utf8');
      git(path, ['add', '--', '预览后变化.txt']);
      git(path, ['commit', '-m', '预览后改变 HEAD']);
    }

    const approvalInput = {
      batchVersion: previewed.version,
      selectedItemIds: previewed.items.map((item) => item.id),
      acknowledgedWarningIds: [],
      confirmation: true as const,
    };
    const idempotency = new IdempotencyService(prisma as unknown as PrismaService);
    const scope = {
      actorId: 'local-user',
      route: `/api/v1/git/batches/${created.batchId}/approve`,
      key: 'same-approval-key-0001',
      requestHash: requestHash(approvalInput),
    };
    const first = await idempotency.start(scope);
    expect(first.kind).toBe('started');
    const approved = await batches.approve(created.batchId, approvalInput, 'local-user');
    if (first.kind === 'started') await idempotency.complete(first.recordId, 202, approved);
    const replay = await idempotency.start(scope);
    expect(replay).toMatchObject({
      kind: 'replay',
      response: { operationId: approved.operationId },
    });

    await registry
      .get('git.batch.execute')!
      .execute(context(approved.operationId, created.batchId));
    const completed = await batches.get(created.batchId);
    expect(completed.status).toBe('partial_failed');
    expect(completed.summary).toMatchObject({ succeeded: 12, stale_preview: 2 });
    expect(completed.items.filter((item) => item.resultCode === 'succeeded')).toHaveLength(12);
    expect(completed.items.filter((item) => item.resultCode === 'stale_preview')).toHaveLength(2);
    expect(await prisma.auditEvent.count({ where: { action: 'git.create_branch' } })).toBe(14);
    expect(await prisma.gitOperationEvent.count()).toBeGreaterThanOrEqual(70);

    for (const [index, path] of repositoryPaths.entries()) {
      expect(branchExists(path, '批次/完整验证')).toBe(index >= 2);
      expect(gitOutput(path, ['branch', '--show-current']).trim()).toBe(
        index >= 2 ? '批次/完整验证' : 'main',
      );
    }
  }, 120_000);

  it('敏感动作必须确认逐仓警告和短语，过期预览绝不批准', async () => {
    const repository = await prisma.repository.findFirstOrThrow({
      orderBy: { displayName: 'asc' },
      skip: 2,
    });
    await writeFile(join(repository.canonicalPath, '待提交.txt'), '敏感提交\n', 'utf8');
    git(repository.canonicalPath, ['add', '--', '待提交.txt']);
    const created = await batches.createPreview(
      {
        action: 'commit',
        repositoryIds: [repository.id],
        parameters: { message: 'feat: 敏感批准验证' },
      },
      'local-user',
    );
    await registry.get('git.batch.preview')!.execute(context(created.operationId, created.batchId));
    const previewed = await batches.get(created.batchId);
    const item = previewed.items[0]!;
    expect(item.executable).toBe(true);
    expect(item.warnings).toHaveLength(1);

    await expect(
      batches.approve(
        created.batchId,
        {
          batchVersion: previewed.version,
          selectedItemIds: [item.id],
          acknowledgedWarningIds: [],
          confirmation: '确认执行',
        },
        'local-user',
      ),
    ).rejects.toMatchObject({ code: 'GIT_WARNING_NOT_ACKNOWLEDGED' });
    await expect(
      batches.approve(
        created.batchId,
        {
          batchVersion: previewed.version,
          selectedItemIds: [item.id],
          acknowledgedWarningIds: [item.warnings[0]!.id],
          confirmation: true,
        },
        'local-user',
      ),
    ).rejects.toMatchObject({ code: 'GIT_CONFIRMATION_REQUIRED' });

    await prisma.gitBatch.update({
      where: { id: created.batchId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      batches.approve(
        created.batchId,
        {
          batchVersion: previewed.version,
          selectedItemIds: [item.id],
          acknowledgedWarningIds: [item.warnings[0]!.id],
          confirmation: '确认执行',
        },
        'local-user',
      ),
    ).rejects.toMatchObject({ code: 'GIT_BATCH_EXPIRED' });
    expect((await batches.get(created.batchId)).status).toBe('expired');
  }, 30_000);
});

function context(jobId: string, batchId: string): JobExecutionContext {
  return {
    jobId,
    payloadRef: batchId,
    isCancellationRequested: () => Promise.resolve(false),
    reportProgress: () => Promise.resolve(),
  };
}
