import { describe, expect, it } from 'vitest';
import type { Integration } from '../api/types.js';
import {
  aiProviderById,
  aiProviderCatalog,
  aiProviderIdFromIntegration,
  defaultAiProviderValues,
  toAiProviderPayload,
} from './ai-provider-catalog.js';

describe('模型供应商目录', () => {
  it('包含多个官方供应商和自定义入口', () => {
    expect(aiProviderCatalog.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'qwen',
      'openrouter',
      'volcengine',
      'siliconflow',
      'custom',
    ]);
  });

  it('根据供应商预填协议、官方地址和首选模型', () => {
    const values = defaultAiProviderValues(aiProviderById('deepseek'));

    expect(values).toMatchObject({
      provider: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai_compatible',
      model: 'deepseek-v4-pro',
    });
  });

  it('提交供应商标识、调用配置和一次性凭证', () => {
    expect(
      toAiProviderPayload({
        ...defaultAiProviderValues(aiProviderById('anthropic')),
        name: '季度自评模型',
        model: 'claude-sonnet-4-6',
        apiKey: 'secret-value',
        allowedPurposes: ['quarterly_review'],
      }),
    ).toEqual({
      type: 'ai',
      name: '季度自评模型',
      baseUrl: 'https://api.anthropic.com',
      config: {
        provider: 'anthropic',
        protocol: 'anthropic',
        model: 'claude-sonnet-4-6',
        metadataOnly: true,
        timeoutMs: 60_000,
        maxInputTokens: 32_000,
        maxOutputTokens: 4_096,
        temperaturePolicy: 'deterministic',
        temperature: 0,
        allowedPurposes: ['quarterly_review'],
      },
      credential: { apiKey: 'secret-value' },
    });
  });

  it('旧 AI 连接按基础地址识别，无法识别时归入自定义供应商', () => {
    const connection: Integration = {
      id: 'ai-1',
      type: 'ai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      credentialMask: { apiKey: '****' },
      enabled: true,
      status: 'healthy',
      capabilities: {},
      config: { protocol: 'openai_compatible', model: 'gpt-5.2' },
      lastTestedAt: null,
      lastSuccessAt: null,
      credentialReplacementPending: false,
      pendingCredentialCreatedAt: null,
      version: 1,
    };
    const customConnection = { ...connection, baseUrl: 'https://llm.example.com/v1' };

    expect(aiProviderIdFromIntegration(connection)).toBe('openai');
    expect(aiProviderIdFromIntegration(customConnection)).toBe('custom');
  });
});
