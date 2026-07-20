import type { RepositoryDiscoveryResult } from '../api/types.js';

export function isRepositoryDiscoveryResult(value: unknown): value is RepositoryDiscoveryResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RepositoryDiscoveryResult>;
  return (
    typeof candidate.root === 'string' &&
    typeof candidate.scannedDirectoryCount === 'number' &&
    Array.isArray(candidate.repositories) &&
    Array.isArray(candidate.warnings)
  );
}

export function repositoryPathEnvironmentLine(key: string, path: string): string | null {
  const normalized = path.trim().replaceAll('\\', '/');
  if (!normalized || /[\0\r\n]/u.test(normalized)) return null;
  // dotenv 双引号值可安全容纳空格；引号必须转义，避免复制后截断配置。
  return `${key}="${normalized.replaceAll('"', '\\"')}"`;
}

export function summarizeRepositoryDiscovery(result: RepositoryDiscoveryResult): string {
  const discovered = result.repositories.length;
  const warnings = result.warnings.length;
  return `扫描完成：检查 ${result.scannedDirectoryCount} 项，登记 ${discovered} 个仓库，警告 ${warnings} 项`;
}
