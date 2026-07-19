import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isolatedData = resolve(repositoryRoot, `tmp/release-gate/database-${process.pid}`);
const releaseRoot = resolve(repositoryRoot, 'dist/release');
if (!isolatedData.startsWith(`${resolve(repositoryRoot, 'tmp/release-gate')}${sep}`)) {
  throw new Error('门禁临时目录越界');
}

rmSync(isolatedData, { recursive: true, force: true });
mkdirSync(isolatedData, { recursive: true });

const gateEnvironment = {
  ...process.env,
  AUTO_WORK_DATA_DIR: isolatedData,
  AUTO_WORK_DATABASE_URL: `file:${resolve(isolatedData, 'release-gate.db').replaceAll('\\', '/')}`,
  AUTO_WORK_SBOM_OUTPUT: resolve(releaseRoot, 'auto-work-sbom.cdx.json'),
  NODE_ENV: 'test',
};

try {
  // 干净安装无法从 monorepo 根目录自动定位 API schema，必须先生成带完整模型类型的 Prisma Client。
  runPnpm(['db:generate'], gateEnvironment);
  runPnpm(['verify'], gateEnvironment);
  runPnpm(['db:validate'], gateEnvironment);
  runPnpm(['db:deploy'], gateEnvironment);
  runPnpm(['db:status'], gateEnvironment);
  runPnpm(['security:secrets'], gateEnvironment);
  runPnpm(['security:audit'], gateEnvironment);
  runPnpm(['sbom:generate'], gateEnvironment);
  runPnpm(['sbom:validate'], gateEnvironment);
  runPnpm(['release:package'], gateEnvironment);
  console.log('发布门禁通过：质量、迁移、秘密、依赖、SBOM 与发布包均已验证。');
} finally {
  rmSync(isolatedData, { recursive: true, force: true });
}

function runPnpm(arguments_, environment) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint) throw new Error('release:gate 必须通过 pnpm 运行');
  console.log(`\n>>> pnpm ${arguments_.join(' ')}`);
  const result = spawnSync(process.execPath, [pnpmEntrypoint, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`pnpm ${arguments_.join(' ')} 失败，退出码 ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}
