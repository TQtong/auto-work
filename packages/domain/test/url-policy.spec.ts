import { describe, expect, it } from 'vitest';
import { isAddressAllowed, normalizeHttpsBaseUrl } from '../src/lib/url-policy.js';

describe('外部地址安全策略', () => {
  it('拒绝非 HTTPS、凭证 URL 和本机地址', () => {
    expect(() =>
      normalizeHttpsBaseUrl('http://git.example.com', { allowPrivateNetwork: true }),
    ).toThrow();
    expect(() =>
      normalizeHttpsBaseUrl('https://token@git.example.com', { allowPrivateNetwork: true }),
    ).toThrow();
    expect(() =>
      normalizeHttpsBaseUrl('https://127.0.0.1', { allowPrivateNetwork: true }),
    ).toThrow();
  });

  it('企业适配器可显式允许私网，但 AI 默认不可访问私网', () => {
    expect(isAddressAllowed('10.20.30.40', true)).toBe(true);
    expect(isAddressAllowed('10.20.30.40', false)).toBe(false);
    expect(isAddressAllowed('169.254.169.254', true)).toBe(false);
    expect(isAddressAllowed('::ffff:127.0.0.1', true)).toBe(false);
    expect(isAddressAllowed('::ffff:a9fe:a9fe', true)).toBe(false);
    expect(isAddressAllowed('::ffff:0a14:1e28', true)).toBe(true);
    expect(isAddressAllowed('::ffff:0a14:1e28', false)).toBe(false);
    expect(isAddressAllowed('ff02::1', true)).toBe(false);
  });

  it('规范化尾部斜杠但保留路径大小写', () => {
    expect(
      normalizeHttpsBaseUrl('https://Git.Example.com/Group/Api///', {
        allowPrivateNetwork: true,
      }).toString(),
    ).toBe('https://git.example.com/Group/Api');
  });
});
