import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/config.module.js';
import {
  repositoryDirectoryPickerMode,
  RepositoryDirectoryPickerService,
} from '../src/modules/repositories/repository-directory-picker.service.js';

const temporaryDirectories: string[] = [];

function config(root: string, deploymentMode: 'native' | 'docker'): AppConfig {
  return {
    host: deploymentMode === 'docker' ? '0.0.0.0' : '127.0.0.1',
    port: 3760,
    dataDir: join(root, 'data'),
    webDist: join(root, 'web'),
    databaseUrl: `file:${join(root, 'test.db').replaceAll('\\', '/')}`,
    repositoryRoot: root,
    deploymentMode,
    vaultBackend: 'sealed',
    vaultKeyFile: join(root, 'data', 'vault-master.key'),
    logLevel: 'info',
    environment: 'test',
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('仓库根目录选择器', () => {
  it('只在 Windows 本机进程启用可返回绝对路径的原生选择器', () => {
    expect(repositoryDirectoryPickerMode('native', 'win32')).toBe('native');
    expect(repositoryDirectoryPickerMode('native', 'linux')).toBe('browser_assisted');
    expect(repositoryDirectoryPickerMode('docker', 'win32')).toBe('browser_assisted');
  });

  it('验证原生选择结果确实是当前进程可访问的目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-work-picker-'));
    temporaryDirectories.push(root);
    const selected = join(root, '仓库目录');
    await mkdir(selected);
    const executor = vi.fn().mockResolvedValue(selected);
    const picker = new RepositoryDirectoryPickerService(config(root, 'native'), executor, 'win32');

    await expect(picker.select(root)).resolves.toEqual({
      status: 'selected',
      path: selected,
    });
    expect(executor).toHaveBeenCalledWith(root);
  });

  it('区分用户取消，并拒绝 Docker 容器伪装成可打开宿主机窗口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-work-picker-'));
    temporaryDirectories.push(root);
    const cancelledExecutor = vi.fn().mockResolvedValue(null);
    const nativePicker = new RepositoryDirectoryPickerService(
      config(root, 'native'),
      cancelledExecutor,
      'win32',
    );
    await expect(nativePicker.select()).resolves.toEqual({ status: 'cancelled', path: null });

    const dockerExecutor = vi.fn();
    const dockerPicker = new RepositoryDirectoryPickerService(
      config(root, 'docker'),
      dockerExecutor,
      'linux',
    );
    await expect(dockerPicker.select()).rejects.toMatchObject({
      code: 'NATIVE_DIRECTORY_PICKER_UNAVAILABLE',
    });
    expect(dockerExecutor).not.toHaveBeenCalled();
  });
});
