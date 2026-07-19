import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { CredentialVaultRouterService } from '../src/infrastructure/vault/credential-vault-router.service.js';
import type { SealedFileVaultService } from '../src/infrastructure/vault/sealed-file-vault.service.js';
import type { WindowsDpapiVaultService } from '../src/infrastructure/vault/windows-dpapi-vault.service.js';

function fakeVault(prefix: string) {
  return {
    put: vi.fn(() => Promise.resolve(`${prefix}:00000000-0000-4000-8000-000000000001`)),
    get: vi.fn((reference: string) => Promise.resolve(`secret:${reference}`)),
    delete: vi.fn(() => Promise.resolve()),
  };
}

function config(vaultBackend: AppConfig['vaultBackend']): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3760,
    dataDir: 'data',
    webDist: 'web',
    databaseUrl: 'file:data/test.db',
    repositoryRoot: 'repositories',
    vaultBackend,
    vaultKeyFile: 'data/master.key',
    logLevel: 'info',
    environment: 'test',
  };
}

describe('凭据保险箱路由', () => {
  it('新凭据使用显式密封后端，旧引用按自身前缀读取和删除', async () => {
    const dpapi = fakeVault('dpapi');
    const sealed = fakeVault('sealed');
    const router = new CredentialVaultRouterService(
      config('sealed'),
      dpapi as unknown as WindowsDpapiVaultService,
      sealed as unknown as SealedFileVaultService,
    );

    await expect(router.put('new')).resolves.toMatch(/^sealed:/);
    await router.get('dpapi:00000000-0000-4000-8000-000000000001');
    await router.delete('sealed:00000000-0000-4000-8000-000000000001');

    expect(sealed.put).toHaveBeenCalledWith('new');
    expect(dpapi.get).toHaveBeenCalledOnce();
    expect(sealed.delete).toHaveBeenCalledOnce();
  });

  it('拒绝未知引用协议', async () => {
    const router = new CredentialVaultRouterService(
      config('sealed'),
      fakeVault('dpapi') as unknown as WindowsDpapiVaultService,
      fakeVault('sealed') as unknown as SealedFileVaultService,
    );

    await expect(router.get('plain:secret')).rejects.toMatchObject({
      code: 'CREDENTIAL_REFERENCE_INVALID',
    });
  });
});
