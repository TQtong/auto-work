import { describe, expect, it } from 'vitest';
import {
  repositoryPathEnvironmentLine,
  summarizeRepositoryDiscovery,
} from './repository-discovery-view-model.js';

describe('仓库扫描配置视图模型', () => {
  it('生成可复制的 Docker 路径配置并统一 Windows 分隔符', () => {
    expect(repositoryPathEnvironmentLine('AUTO_WORK_REPOSITORY_PATH', ' D:\\company ')).toBe(
      'AUTO_WORK_REPOSITORY_PATH="D:/company"',
    );
    expect(
      repositoryPathEnvironmentLine('AUTO_WORK_REPOSITORY_PATH', 'D:\\company\nINJECT=1'),
    ).toBe(null);
  });

  it('完整汇总扫描目录、登记仓库和跳过项', () => {
    expect(
      summarizeRepositoryDiscovery({
        root: '/repositories',
        repositories: [{}, {}] as never[],
        warnings: [{ directory: 'docs', code: 'NOT_A_GIT_REPOSITORY', message: '不是仓库' }],
        scannedDirectoryCount: 3,
      }),
    ).toBe('扫描完成：检查 3 项，登记 2 个仓库，警告 1 项');
  });
});
