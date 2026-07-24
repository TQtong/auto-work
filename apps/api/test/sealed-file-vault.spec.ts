import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { SealedFileVaultService } from '../src/infrastructure/vault/sealed-file-vault.service.js';

const temporaryDirectories: string[] = [];

async function createConfig(): Promise<AppConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), 'auto-work-sealed-vault-'));
  temporaryDirectories.push(dataDir);
  return {
    host: '127.0.0.1',
    port: 3760,
    dataDir,
    webDist: join(dataDir, 'web'),
    databaseUrl: `file:${join(dataDir, 'test.db').replaceAll('\\', '/')}`,
    repositoryRoot: join(dataDir, 'repositories'),
    vaultBackend: 'sealed',
    vaultKeyFile: join(dataDir, 'vault-master.key'),
    logLevel: 'info',
    environment: 'test',
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('跨平台密封文件凭据保险箱', () => {
  it('只落盘认证密文并支持读取和幂等撤销', async () => {
    const config = await createConfig();
    const vault = new SealedFileVaultService(config);
    const secret = 'Docker 集成凭据-仅用于测试-42';

    const reference = await vault.put(secret);

    expect(reference).toMatch(/^sealed:[0-9a-f-]{36}$/i);
    const files = await readdir(join(config.dataDir, 'vault'));
    expect(files).toHaveLength(1);
    expect(await readFile(join(config.dataDir, 'vault', files[0]!), 'utf8')).not.toContain(secret);
    expect(await readFile(config.vaultKeyFile, 'utf8')).not.toContain(secret);
    await expect(vault.get(reference)).resolves.toBe(secret);

    await vault.delete(reference);
    await vault.delete(reference);
    await expect(vault.get(reference)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('拒绝被篡改的密文且不泄露加密库细节', async () => {
    const config = await createConfig();
    const vault = new SealedFileVaultService(config);
    const reference = await vault.put('需要完整性保护的凭据');
    const id = reference.slice('sealed:'.length);
    const path = join(config.dataDir, 'vault', `${id}.sealed`);
    const envelope = JSON.parse(await readFile(path, 'utf8')) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    envelope.ciphertext = ciphertext.toString('base64');
    await writeFile(path, `${JSON.stringify(envelope)}\n`, 'utf8');

    await expect(vault.get(reference)).rejects.toMatchObject({
      code: 'CREDENTIAL_DECRYPT_FAILED',
      message: '凭证解密或完整性校验失败',
    });
  });

  it('错误主密钥不能解密已有密文', async () => {
    const config = await createConfig();
    const original = new SealedFileVaultService(config);
    const reference = await original.put('不能被错误密钥读取');
    const wrongKeyPath = join(config.dataDir, 'wrong-master.key');
    await writeFile(wrongKeyPath, `${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8');
    const wrong = new SealedFileVaultService({ ...config, vaultKeyFile: wrongKeyPath });

    await expect(wrong.get(reference)).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPT_FAILED' });
  });

  it('并发首启只创建一个主密钥且不同实例可以交叉解密', async () => {
    const config = await createConfig();
    const first = new SealedFileVaultService(config);
    const second = new SealedFileVaultService(config);

    const [firstReference, secondReference] = await Promise.all([
      first.put('并发秘密 A'),
      second.put('并发秘密 B'),
    ]);

    await expect(second.get(firstReference)).resolves.toBe('并发秘密 A');
    await expect(first.get(secondReference)).resolves.toBe('并发秘密 B');
  });
});
