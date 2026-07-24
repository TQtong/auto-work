import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { WindowsDpapiVaultService } from '../src/infrastructure/vault/windows-dpapi-vault.service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // 目录由本测试通过 mkdtemp 创建，删除范围不会越过测试隔离目录。
    await rm(directory, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')('Windows DPAPI 保险箱', () => {
  it('只落盘密文引用，并能读取和撤销当前用户秘密', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'auto-work-dpapi-'));
    temporaryDirectories.push(dataDirectory);
    const config: AppConfig = {
      host: '127.0.0.1',
      port: 3760,
      dataDir: dataDirectory,
      webDist: join(dataDirectory, 'web'),
      databaseUrl: `file:${join(dataDirectory, 'test.db').replaceAll('\\', '/')}`,
      repositoryRoot: 'D:\\company',
      vaultBackend: 'dpapi',
      vaultKeyFile: join(dataDirectory, 'vault-master.key'),
      logLevel: 'info',
      environment: 'test',
    };
    const vault = new WindowsDpapiVaultService(config);
    const secret = '仅用于自动化验证的秘密-42';

    const reference = await vault.put(secret);
    expect(reference).toMatch(/^dpapi:[0-9a-f-]{36}$/i);
    const vaultFiles = await readdir(join(dataDirectory, 'vault'));
    expect(vaultFiles).toHaveLength(1);
    expect(await readFile(join(dataDirectory, 'vault', vaultFiles[0]!), 'utf8')).not.toContain(
      secret,
    );
    await expect(vault.get(reference)).resolves.toBe(secret);

    await vault.delete(reference);
    await expect(vault.get(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 75_000); // 加密和解密各有 30 秒生产预算；独立单 worker 测试还需覆盖落盘、撤销与清理过程。
});
