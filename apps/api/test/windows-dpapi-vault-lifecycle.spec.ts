import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import { WindowsDpapiVaultService } from '../src/infrastructure/vault/windows-dpapi-vault.service.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

interface ProtectedDataRunner {
  runProtectedData(script: string, input: string): Promise<string>;
}

function createVault(): WindowsDpapiVaultService {
  const dataDirectory = join(process.cwd(), '.test-dpapi-lifecycle');
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
  return new WindowsDpapiVaultService(config);
}

function createFakeChild() {
  const events = new EventEmitter();
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
    kill: vi.fn(() => true),
    once: events.once.bind(events),
    emit: events.emit.bind(events),
  };
}

function runProtectedData(vault: WindowsDpapiVaultService): Promise<string> {
  // 生命周期行为位于私有适配器边界；测试通过窄接口验证，不扩大生产类的公开 API。
  return (vault as unknown as ProtectedDataRunner).runProtectedData('test-script', 'secret');
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe('Windows DPAPI 子进程生命周期', () => {
  it('达到截止时间时立即拒绝调用并尽力终止未关闭的子进程', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const operation = runProtectedData(createVault());
    const assertion = expect(operation).rejects.toMatchObject({
      code: 'DPAPI_OPERATION_TIMEOUT',
      options: { httpStatus: 504, details: { timeoutMs: 30_000 } },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();

    // close 即使永久不触发，调用方 Promise 也已经在截止时间确定性收敛。
    expect(child.stdin.end).toHaveBeenCalledWith('secret', 'utf8');
  });

  it('把进程启动错误映射成不泄露本机路径的稳定领域错误', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const operation = runProtectedData(createVault());
    child.emit(
      'error',
      Object.assign(new Error('D:\\sensitive\\powershell.exe'), { code: 'ENOENT' }),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'DPAPI_PROCESS_START_FAILED',
      message: 'Windows 凭证保护进程启动失败',
      options: { httpStatus: 503, details: { processErrorCode: 'ENOENT' } },
    });
  });
});
