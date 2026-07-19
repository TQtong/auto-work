import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '../../..');
const dataDirectory = resolveWorkspacePath(process.env.AUTO_WORK_DATA_DIR ?? './data');
const configuredUrl = process.env.AUTO_WORK_DATABASE_URL;
const configuredPath = configuredUrl?.startsWith('file:')
  ? configuredUrl.slice('file:'.length)
  : undefined;
const databasePath = configuredPath
  ? resolveWorkspacePath(configuredPath)
  : resolve(dataDirectory, 'auto-work.db');
const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`;

function resolveWorkspacePath(value) {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

// Prisma 的 schema engine 不会为不存在的父目录建库；CLI 入口统一先准备目录并注入绝对 URL。
await mkdir(dirname(databasePath), { recursive: true });
const databaseHandle = await open(databasePath, 'a');
await databaseHandle.close();

const prismaCli = require.resolve('prisma/build/index.js');
const child = spawn(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: resolve(workspaceRoot, 'apps/api'),
  env: { ...process.env, AUTO_WORK_DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error('无法启动 Prisma CLI：', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Prisma CLI 被信号 ${signal} 中止。`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
