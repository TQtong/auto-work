export interface BrowserDirectoryPickerWindow {
  showDirectoryPicker?: (options: {
    id: string;
    mode: 'read';
  }) => Promise<{ name: string; path?: unknown }>;
}

export type BrowserDirectorySelection =
  | { status: 'selected'; displayName: string; absolutePath: string | null }
  | { status: 'cancelled' }
  | { status: 'unsupported' };

export function safePickerAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || /[\0\r\n]/u.test(path)) return null;
  if (!/^(?:[a-z]:[\\/]|\/)/iu.test(path)) return null;
  return path;
}

/**
 * 标准浏览器只返回目录句柄和名称，不暴露宿主机绝对路径；部分桌面 WebView 会额外提供 path。
 * 这里只接受明确返回的绝对路径，绝不根据目录名或当前输入猜测磁盘位置。
 */
export async function selectBrowserDirectory(
  browserWindow: BrowserDirectoryPickerWindow,
): Promise<BrowserDirectorySelection> {
  if (!browserWindow.showDirectoryPicker) return { status: 'unsupported' };
  try {
    const handle = await browserWindow.showDirectoryPicker({
      id: 'auto-work-repository-root',
      mode: 'read',
    });
    return {
      status: 'selected',
      displayName: handle.name,
      absolutePath: safePickerAbsolutePath(handle.path),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
      return { status: 'cancelled' };
    }
    throw error;
  }
}
