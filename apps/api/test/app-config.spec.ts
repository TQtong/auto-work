import { afterEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppConfig } from '../src/config/app-config.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const managedKeys = ['AUTO_WORK_DATA_DIR', 'AUTO_WORK_DATABASE_URL', 'AUTO_WORK_WEB_DIST'] as const;
const originalEnvironment = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of managedKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('应用路径配置', () => {
  it('相对数据路径和数据库 URL 均以仓库根目录解析', () => {
    process.env.AUTO_WORK_DATA_DIR = './data/config-test';
    process.env.AUTO_WORK_DATABASE_URL = 'file:./data/config-test/custom.db';
    process.env.AUTO_WORK_WEB_DIST = './apps/web/dist';

    const config = loadAppConfig();
    const expectedDataDirectory = resolve(workspaceRoot, 'data/config-test');
    expect(config.dataDir).toBe(expectedDataDirectory);
    expect(config.databaseUrl).toBe(
      `file:${resolve(workspaceRoot, 'data/config-test/custom.db').replaceAll('\\', '/')}`,
    );
    expect(config.webDist).toBe(resolve(workspaceRoot, 'apps/web/dist'));
  });

  it('未配置数据库 URL 时使用数据目录中的默认文件', () => {
    process.env.AUTO_WORK_DATA_DIR = './data/default-url-test';
    delete process.env.AUTO_WORK_DATABASE_URL;

    const config = loadAppConfig();
    expect(config.databaseUrl).toBe(
      `file:${resolve(workspaceRoot, 'data/default-url-test/auto-work.db').replaceAll('\\', '/')}`,
    );
  });
});
