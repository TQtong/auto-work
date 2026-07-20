import { describe, expect, it, vi } from 'vitest';
import { safePickerAbsolutePath, selectBrowserDirectory } from './repository-directory-picker.js';

describe('浏览器仓库目录选择器', () => {
  it('只接受选择器明确返回的绝对路径，不根据目录名猜测位置', () => {
    expect(safePickerAbsolutePath(' D:\\company ')).toBe('D:\\company');
    expect(safePickerAbsolutePath('/Users/developer/company')).toBe('/Users/developer/company');
    expect(safePickerAbsolutePath('company')).toBe(null);
    expect(safePickerAbsolutePath('D:\\company\nINJECT=1')).toBe(null);
  });

  it('标准浏览器只返回目录名时保留人工确认边界', async () => {
    await expect(
      selectBrowserDirectory({
        showDirectoryPicker: vi.fn().mockResolvedValue({ name: 'company' }),
      }),
    ).resolves.toEqual({
      status: 'selected',
      displayName: 'company',
      absolutePath: null,
    });
  });

  it('识别不支持选择器和用户取消', async () => {
    await expect(selectBrowserDirectory({})).resolves.toEqual({ status: 'unsupported' });
    await expect(
      selectBrowserDirectory({
        showDirectoryPicker: vi.fn().mockRejectedValue(new DOMException('用户取消', 'AbortError')),
      }),
    ).resolves.toEqual({ status: 'cancelled' });
  });
});
