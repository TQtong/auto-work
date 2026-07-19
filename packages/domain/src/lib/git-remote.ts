export interface NormalizedGitRemote {
  protocol: 'https' | 'ssh';
  host: string;
  port: number | null;
  path: string;
  namespace: string;
  project: string;
  sanitizedUrl: string;
}

/**
 * 解析 GitLab 常见远端格式。返回值刻意丢弃用户名、密码和查询参数，确保远端中的秘密不会入库。
 */
export function normalizeGitRemote(value: string): NormalizedGitRemote | null {
  const input = value.trim();
  if (!input || /[\0\r\n]/u.test(input)) return null;

  if (/^https:\/\//iu.test(input)) return normalizeUrlRemote(input, 'https');
  if (/^ssh:\/\//iu.test(input)) return normalizeUrlRemote(input, 'ssh');

  const scpLike = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/u.exec(input);
  if (!scpLike?.[1] || !scpLike[2]) return null;
  return buildRemote('ssh', scpLike[1], null, scpLike[2]);
}

function normalizeUrlRemote(
  input: string,
  expectedProtocol: 'https' | 'ssh',
): NormalizedGitRemote | null {
  try {
    const url = new URL(input);
    if (url.protocol !== `${expectedProtocol}:` || url.hash || url.search) return null;
    const defaultPort = expectedProtocol === 'https' ? 443 : 22;
    const port = url.port ? Number(url.port) : null;
    return buildRemote(
      expectedProtocol,
      url.hostname,
      port === defaultPort ? null : port,
      decodeURIComponent(url.pathname),
    );
  } catch {
    return null;
  }
}

function buildRemote(
  protocol: 'https' | 'ssh',
  rawHost: string,
  port: number | null,
  rawPath: string,
): NormalizedGitRemote | null {
  const host = rawHost.toLowerCase().replace(/\.$/u, '');
  const path = rawPath.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  const segments = path.split('/').filter(Boolean);
  const project = segments.at(-1);
  if (!host || !project || segments.length < 2 || !/^[-a-z0-9._]+$/iu.test(host)) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const namespace = segments.slice(0, -1).join('/');
  const portSuffix = port ? `:${port}` : '';
  const sanitizedUrl =
    protocol === 'https'
      ? `https://${host}${portSuffix}/${path}`
      : `ssh://${host}${portSuffix}/${path}`;
  return { protocol, host, port, path, namespace, project, sanitizedUrl };
}
