import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { PrismaClient } from '../../apps/api/node_modules/@prisma/client/default.js';
import { generateWeeklyReportRuleDraft } from '../../packages/domain/dist/index.js';
import { GitProcessService } from '../../apps/api/dist/infrastructure/git/git-process.service.js';
import { TasksController } from '../../apps/api/dist/modules/jira/tasks.controller.js';
import { RepositoryInspectorService } from '../../apps/api/dist/modules/repositories/repository-inspector.service.js';
import { RepositoryService } from '../../apps/api/dist/modules/repositories/repository.service.js';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, '../..');
const argumentsMap = parseArguments(process.argv.slice(2));
const repositoryRoot = resolve(
  argumentsMap.get('repository-root') ?? process.env.AUTO_WORK_REPOSITORY_ROOT ?? 'D:\\company',
);
const expectedRepositoryCount = 14;
const sampleRounds = Number(argumentsMap.get('rounds') ?? '30');
const gitRounds = Number(argumentsMap.get('git-rounds') ?? '10');
const outputBase = resolve(
  workspaceRoot,
  argumentsMap.get('output') ?? 'tmp/nfr-performance/nfr-performance-report',
);

validateMinimumInteger('rounds', sampleRounds, 20);
validateMinimumInteger('git-rounds', gitRounds, 5);

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-work-nfr-performance-'));
const databasePath = join(temporaryDirectory, 'benchmark.db');
const prisma = new PrismaClient({
  datasourceUrl: `file:${databasePath.replaceAll('\\', '/')}`,
});

try {
  await applyAllMigrations(prisma);
  await seedPerformanceData(prisma);

  const repositoryList = await benchmarkRepositoryList(prisma);
  const taskList = await benchmarkTaskList(prisma);
  const weeklyRules = benchmarkWeeklyRules();
  const localGit = await benchmarkLocalGit();
  const commit = await readCommit();
  const checks = [
    makeCheck('AC-NFR-PERF-01', repositoryList.p95Ms, 2_000, '14 仓库缓存首屏'),
    makeCheck('任务列表容量', taskList.p95Ms, 2_000, '10,000 条本地记录分页'),
    makeCheck('AC-NFR-PERF-03', weeklyRules.p95Ms, 10_000, '500 任务/2,000 证据规则生成'),
    makeCheck('AC-NFR-PERF-02', localGit.worstRepositoryP95Ms, 5_000, '最慢单仓库本地状态刷新'),
  ];
  const repositoryCountCheck = {
    id: 'PRJ-001',
    description: '真实仓库根目录一级 Git 仓库数量',
    observed: localGit.repositoryCount,
    expected: expectedRepositoryCount,
    passed: localGit.repositoryCount === expectedRepositoryCount,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuCount: (await import('node:os')).cpus().length,
      repositoryRoot,
    },
    dataset: {
      repositories: expectedRepositoryCount,
      tasks: 10_000,
      weeklyTasks: 500,
      weeklyEvidence: 2_000,
      measuredRounds: sampleRounds,
      gitRounds,
    },
    results: { repositoryList, taskList, weeklyRules, localGit },
    checks: [...checks, repositoryCountCheck],
    passed: checks.every((check) => check.passed) && repositoryCountCheck.passed,
  };

  await mkdir(dirname(outputBase), { recursive: true });
  await writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(`${outputBase}.md`, renderMarkdown(report), 'utf8');
  process.stdout.write(`${renderConsoleSummary(report)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  // 临时数据库由本次基准独占，且路径来自 mkdtemp；结束后只清理这个精确目录。
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function benchmarkRepositoryList(client) {
  const service = new RepositoryService(client, {});
  const action = async () => {
    const result = await service.list();
    if (result.length !== expectedRepositoryCount) {
      throw new Error(`仓库缓存返回 ${result.length} 条，预期 ${expectedRepositoryCount} 条`);
    }
  };
  return measureAsync('repository-list', action, sampleRounds, 3);
}

async function benchmarkTaskList(client) {
  const controller = new TasksController(client);
  const request = { autoWork: { correlationId: 'nfr-performance-benchmark' } };
  let cursor;
  const action = async () => {
    const response = await controller.list(
      { visibility: 'visible', limit: '100', ...(cursor ? { cursor } : {}) },
      request,
    );
    if (response.data.length !== 100 || response.total !== 10_000) {
      throw new Error(`任务分页返回 ${response.data.length}/${response.total}，容量样本不完整`);
    }
    cursor = response.page.nextCursor;
    if (!cursor) cursor = undefined;
  };
  return measureAsync('task-list', action, sampleRounds, 3);
}

function benchmarkWeeklyRules() {
  const tasks = Array.from({ length: 500 }, (_, index) => ({
    id: `weekly-task-${index}`,
    issueKey: `PERF-${index + 1}`,
    projectId: `project-${index % expectedRepositoryCount}`,
    projectName: `性能项目 ${index % expectedRepositoryCount}`,
    title: `容量验收任务 ${index + 1}`,
    normalizedStatus: index % 9 === 0 ? 'blocked' : index % 3 === 0 ? 'done' : 'in_progress',
    priority: index % 7 === 0 ? 'highest' : 'medium',
    plannedStartDate: '2026-07-13',
    dueDate: index % 11 === 0 ? '2026-07-16' : '2026-07-24',
    timeSpentSeconds: index * 60,
    originalEstimateSeconds: 28_800,
    remainingEstimateSeconds: 14_400,
    sprintActive: index % 2 === 0,
    isCurrentUser: true,
    visibilityState: 'visible',
    lastObservedAt: '2026-07-17T09:00:00+08:00',
    statusChangedAt: '2026-07-16T10:00:00+08:00',
    sourceFreshness: 'fresh',
  }));
  const evidence = Array.from({ length: 2_000 }, (_, index) => ({
    id: `weekly-evidence-${index}`,
    taskId: `weekly-task-${index % 500}`,
    projectId: `project-${index % expectedRepositoryCount}`,
    sourceType: index % 5 === 0 ? 'pipeline' : index % 2 === 0 ? 'commit' : 'merge_request',
    title: `容量验收证据 ${index + 1}`,
    eventAt: `2026-07-${String(13 + (index % 5)).padStart(2, '0')}T09:00:00+08:00`,
    relationStatus: 'confirmed',
    revalidationState: 'valid',
    availabilityState: 'available',
    pipelineStatus: index % 19 === 0 ? 'failed' : 'success',
  }));
  const input = {
    periodStart: '2026-07-13',
    periodEnd: '2026-07-17',
    reportDate: '2026-07-17',
    timezone: 'Asia/Shanghai',
    calendarVersion: 'benchmark-calendar-v1',
    tasks,
    evidence,
    manualInputs: [],
  };
  const action = () => {
    const report = generateWeeklyReportRuleDraft(input);
    if (report.sourceIds.taskIds.length !== 500 || report.sourceIds.evidenceIds.length !== 2_000) {
      throw new Error('周报规则引擎没有消费完整容量样本');
    }
  };
  return measureSync('weekly-rules', action, sampleRounds, 3);
}

async function benchmarkLocalGit() {
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const repositories = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(repositoryRoot, entry.name);
    const marker = await stat(join(candidate, '.git')).catch(() => null);
    if (marker?.isDirectory() || marker?.isFile()) repositories.push(candidate);
  }
  repositories.sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const git = new GitProcessService();
  const config = {
    host: '127.0.0.1',
    port: 3760,
    dataDir: temporaryDirectory,
    webDist: temporaryDirectory,
    databaseUrl: `file:${databasePath.replaceAll('\\', '/')}`,
    repositoryRoot,
    logLevel: 'error',
    environment: 'test',
  };
  const inspector = new RepositoryInspectorService(config, git);
  const observations = [];
  for (const repositoryPath of repositories) {
    const countObjects = await git.runRead(repositoryPath, ['count-objects', '-v']);
    const sizePackKiB = Number(
      /^size-pack:\s*(\d+)$/mu.exec(countObjects.stdout.toString('utf8'))?.[1] ?? 0,
    );
    await inspector.collectStatus(repositoryPath);
    const durations = [];
    for (let round = 0; round < gitRounds; round += 1) {
      const startedAt = performance.now();
      await inspector.collectStatus(repositoryPath);
      durations.push(performance.now() - startedAt);
    }
    observations.push({
      name: basename(repositoryPath),
      sizePackKiB,
      p95Ms: roundMilliseconds(percentile(durations, 0.95)),
      maximumMs: roundMilliseconds(Math.max(...durations)),
      samplesMs: durations.map(roundMilliseconds),
    });
  }
  const bySize = [...observations].sort((left, right) => left.sizePackKiB - right.sizePackKiB);
  for (const [index, observation] of bySize.entries()) {
    observation.layer =
      index < bySize.length / 3 ? 'small' : index < (bySize.length * 2) / 3 ? 'medium' : 'large';
  }
  const allSamples = observations.flatMap((observation) => observation.samplesMs);
  const layers = Object.fromEntries(
    ['small', 'medium', 'large'].map((layer) => {
      const samples = observations
        .filter((item) => item.layer === layer)
        .flatMap((item) => item.samplesMs);
      return [
        layer,
        {
          repositoryCount: observations.filter((item) => item.layer === layer).length,
          p95Ms: roundMilliseconds(percentile(samples, 0.95)),
        },
      ];
    }),
  );
  return {
    repositoryCount: observations.length,
    overallP95Ms: roundMilliseconds(percentile(allSamples, 0.95)),
    worstRepositoryP95Ms: roundMilliseconds(
      Math.max(...observations.map((observation) => observation.p95Ms)),
    ),
    maximumMs: roundMilliseconds(Math.max(...allSamples)),
    layers,
    repositories: observations,
  };
}

async function seedPerformanceData(client) {
  const observedAt = new Date();
  await client.project.createMany({
    data: Array.from({ length: expectedRepositoryCount }, (_, index) => ({
      id: `project-${index}`,
      name: `容量项目 ${index + 1}`,
      jiraProjectKey: `PERF${index + 1}`,
      sortOrder: index,
    })),
  });
  await client.repository.createMany({
    data: Array.from({ length: expectedRepositoryCount }, (_, index) => ({
      id: `repository-${index}`,
      projectId: `project-${index}`,
      canonicalPath: `D:\\company\\benchmark-${index}`,
      realPathHash: `real-${index}`,
      identityHash: `identity-${index}`,
      displayName: `benchmark-${index}`,
      gitDirKind: 'normal',
      baselineBranch: 'main',
      whitelistStatus: 'confirmed',
      lastSeenAt: observedAt,
      lastLocalRefreshAt: observedAt,
    })),
  });
  await client.gitSnapshot.createMany({
    data: Array.from({ length: expectedRepositoryCount }, (_, index) => ({
      id: `snapshot-${index}`,
      repositoryId: `repository-${index}`,
      headSha: `${String(index).padStart(2, '0')}${'0'.repeat(38)}`,
      branchName: 'main',
      recentCommitJson: JSON.stringify({ title: `容量提交 ${index}` }),
      collectedAt: observedAt,
    })),
  });
  const batchSize = 250;
  for (let start = 0; start < 10_000; start += batchSize) {
    await client.task.createMany({
      data: Array.from({ length: Math.min(batchSize, 10_000 - start) }, (_, offset) => {
        const index = start + offset;
        return {
          id: `task-${index}`,
          projectId: `project-${index % expectedRepositoryCount}`,
          primarySource: index % 5 === 0 ? 'excel' : 'jira',
          issueKey: `PERF${(index % expectedRepositoryCount) + 1}-${index + 1}`,
          projectKey: `PERF${(index % expectedRepositoryCount) + 1}`,
          title: `容量任务 ${index + 1}`,
          isCurrentUser: true,
          normalizedStatus: index % 7 === 0 ? 'done' : index % 11 === 0 ? 'blocked' : 'in_progress',
          dueDate: index % 13 === 0 ? '2020-01-01' : '2099-12-31',
          externalUpdatedAt: new Date(observedAt.getTime() - index * 1_000),
          lastObservedAt: observedAt,
          visibilityState: 'visible',
        };
      }),
    });
  }
}

async function applyAllMigrations(client) {
  const migrationRoot = resolve(workspaceRoot, 'apps/api/prisma/migrations');
  const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8');
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/u).map((value) => value.trim())) {
      if (statement) await client.$executeRawUnsafe(statement);
    }
  }
}

async function measureAsync(name, action, rounds, warmups) {
  for (let index = 0; index < warmups; index += 1) await action();
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const startedAt = performance.now();
    await action();
    samples.push(performance.now() - startedAt);
  }
  return summarizeSamples(name, samples);
}

function measureSync(name, action, rounds, warmups) {
  for (let index = 0; index < warmups; index += 1) action();
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const startedAt = performance.now();
    action();
    samples.push(performance.now() - startedAt);
  }
  return summarizeSamples(name, samples);
}

function summarizeSamples(name, samples) {
  return {
    name,
    sampleCount: samples.length,
    minimumMs: roundMilliseconds(Math.min(...samples)),
    medianMs: roundMilliseconds(percentile(samples, 0.5)),
    p95Ms: roundMilliseconds(percentile(samples, 0.95)),
    maximumMs: roundMilliseconds(Math.max(...samples)),
    samplesMs: samples.map(roundMilliseconds),
  };
}

function percentile(samples, quantile) {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

function makeCheck(id, observedMs, thresholdMs, description) {
  return { id, description, observedMs, thresholdMs, passed: observedMs <= thresholdMs };
}

async function readCommit() {
  const result = await execFileAsync('git.exe', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`无法识别的参数：${value}`);
    const [name, inline] = value.slice(2).split('=', 2);
    const next = inline ?? values[index + 1];
    if (!next || (!inline && next.startsWith('--'))) throw new Error(`参数 --${name} 缺少值`);
    result.set(name, next);
    if (inline === undefined) index += 1;
  }
  return result;
}

function validateMinimumInteger(name, value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} 必须是大于等于 ${minimum} 的整数，避免以过少样本伪造 P95`);
  }
}

function renderMarkdown(report) {
  const checkRows = report.checks.map((check) => {
    const observed =
      'observedMs' in check
        ? `${check.observedMs} ms / ${check.thresholdMs} ms`
        : `${check.observed} / ${check.expected}`;
    return `| ${check.id} | ${check.description} | ${observed} | ${check.passed ? '通过' : '失败'} |`;
  });
  const repositoryRows = report.results.localGit.repositories.map(
    (repository) =>
      `| ${repository.name} | ${repository.layer} | ${repository.sizePackKiB} | ${repository.p95Ms} | ${repository.maximumMs} |`,
  );
  return `# NFR 性能基准报告\n\n- 生成时间：${report.generatedAt}\n- 提交：\`${report.commit}\`\n- Node：${report.runtime.node}\n- 仓库根目录：\`${report.runtime.repositoryRoot}\`\n- 总结：**${report.passed ? '全部通过' : '存在失败'}**\n\n## 门禁结果\n\n| 验收项 | 场景 | 实测 / 阈值 | 结果 |\n|---|---|---:|---|\n${checkRows.join('\n')}\n\n## 真实仓库分层\n\n| 仓库 | 分层 | pack KiB | P95 ms | 最大 ms |\n|---|---|---:|---:|---:|\n${repositoryRows.join('\n')}\n\n> JSON 同名文件保留每轮原始样本；本报告不包含源码、diff、远端凭证或 Git 输出。\n`;
}

function renderConsoleSummary(report) {
  const lines = [
    `NFR 性能基准：${report.passed ? '通过' : '失败'}`,
    `仓库缓存 P95: ${report.results.repositoryList.p95Ms} ms`,
    `任务分页 P95: ${report.results.taskList.p95Ms} ms`,
    `周报规则 P95: ${report.results.weeklyRules.p95Ms} ms`,
    `本地 Git 全样本 P95: ${report.results.localGit.overallP95Ms} ms`,
    `本地 Git 最慢单仓 P95: ${report.results.localGit.worstRepositoryP95Ms} ms (${report.results.localGit.repositoryCount} 仓库)`,
    `报告: ${outputBase}.md`,
  ];
  return lines.join('\n');
}
