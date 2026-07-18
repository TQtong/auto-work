import { describe, expect, it } from 'vitest';
import { toIntegrationPayload } from './SettingsPage.js';

describe('AI 连接配置视图模型', () => {
  it('完整提交协议、模型、超时、Token、温度、用途和一次性密钥', () => {
    expect(
      toIntegrationPayload({
        type: 'ai',
        name: '企业外部 AI',
        baseUrl: 'https://api.example/v1',
        apiKey: 'secret-value',
        protocol: 'anthropic',
        model: 'claude-model',
        aiTimeoutMs: 45_000,
        aiMaxInputTokens: 16_000,
        aiMaxOutputTokens: 2_048,
        aiTemperaturePolicy: 'deterministic',
        aiTemperature: 0.2,
        aiAllowedPurposes: ['weekly_report', 'quarterly_review'],
      }),
    ).toEqual({
      type: 'ai',
      name: '企业外部 AI',
      baseUrl: 'https://api.example/v1',
      config: {
        protocol: 'anthropic',
        model: 'claude-model',
        metadataOnly: true,
        timeoutMs: 45_000,
        maxInputTokens: 16_000,
        maxOutputTokens: 2_048,
        temperaturePolicy: 'deterministic',
        temperature: 0.2,
        allowedPurposes: ['weekly_report', 'quarterly_review'],
      },
      credential: { apiKey: 'secret-value' },
    });
  });
});
