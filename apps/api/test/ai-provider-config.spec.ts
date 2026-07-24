import { describe, expect, it } from 'vitest';
import { aiProviderConfigSchema } from '../src/modules/ai/ai-provider.config.js';

const baseConfig = {
  protocol: 'openai_compatible',
  model: 'model-id',
  metadataOnly: true,
  timeoutMs: 60_000,
  maxInputTokens: 32_000,
  maxOutputTokens: 4_096,
  temperaturePolicy: 'deterministic',
  temperature: 0,
  allowedPurposes: ['weekly_report'],
};

describe('AI 供应商配置', () => {
  it('保存合法的供应商标识', () => {
    expect(aiProviderConfigSchema.parse({ ...baseConfig, provider: 'openrouter' }).provider).toBe(
      'openrouter',
    );
  });

  it('为旧连接补充 custom 供应商标识', () => {
    expect(aiProviderConfigSchema.parse(baseConfig).provider).toBe('custom');
  });

  it('拒绝不可展示的供应商标识', () => {
    expect(() =>
      aiProviderConfigSchema.parse({ ...baseConfig, provider: 'Open AI\n<script>' }),
    ).toThrow();
  });
});
