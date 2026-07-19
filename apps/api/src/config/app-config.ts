import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const envSchema = z.object({
  AUTO_WORK_HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  AUTO_WORK_PORT: z.coerce.number().int().min(1024).max(65535).default(3760),
  AUTO_WORK_DATA_DIR: z.string().min(1).default('./data'),
  AUTO_WORK_WEB_DIST: z.string().min(1).default('./apps/web/dist'),
  AUTO_WORK_DATABASE_URL: z.string().min(1).startsWith('file:').optional(),
  AUTO_WORK_REPOSITORY_ROOT: z.string().min(3).default('D:\\company'),
  AUTO_WORK_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export interface AppConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  dataDir: string;
  webDist: string;
  databaseUrl: string;
  repositoryRoot: string;
  logLevel: string;
  environment: 'development' | 'test' | 'production';
}

function resolveWorkspacePath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

function resolveSqliteUrl(value: string | undefined, dataDir: string): string {
  const configuredPath = value?.slice('file:'.length);
  const databasePath = configuredPath
    ? resolveWorkspacePath(configuredPath)
    : resolve(dataDir, 'auto-work.db');

  // Prisma 的 SQLite URL 在 Windows 下也接受正斜杠；统一格式可避免 CLI 与运行时解析到不同文件。
  return `file:${databasePath.replaceAll('\\', '/')}`;
}

export function loadAppConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const dataDir = resolveWorkspacePath(parsed.AUTO_WORK_DATA_DIR);
  return {
    host: parsed.AUTO_WORK_HOST,
    port: parsed.AUTO_WORK_PORT,
    dataDir,
    webDist: resolveWorkspacePath(parsed.AUTO_WORK_WEB_DIST),
    databaseUrl: resolveSqliteUrl(parsed.AUTO_WORK_DATABASE_URL, dataDir),
    repositoryRoot: resolveWorkspacePath(parsed.AUTO_WORK_REPOSITORY_ROOT),
    logLevel: parsed.AUTO_WORK_LOG_LEVEL,
    environment: parsed.NODE_ENV,
  };
}
