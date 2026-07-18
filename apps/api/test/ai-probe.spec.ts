import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@auto-work/contracts';
import { AiProbeService } from '../src/modules/ai/ai-probe.service.js';
import type { AiProviderClient } from '../src/modules/ai/ai-provider.client.js';
import { IntegrationProbeRegistry } from '../src/modules/integrations/integration-probe.registry.js';

describe('AI 真实模型能力探测', () => {
  it('只有真实结构化调用通过后才标记健康，并冻结无工具能力矩阵', async () => {
    const generate = vi.fn().mockResolvedValue({
      protocol: 'anthropic',
      model: 'claude-observed',
      outputText: '{"ok":true,"echo":"AUTO_WORK_AI_PROBE"}',
      stopReason: 'end_turn',
      providerRequestId: 'probe-request',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    });
    const registry = new IntegrationProbeRegistry();
    const probe = new AiProbeService(registry, { generate } as unknown as AiProviderClient);
    probe.onModuleInit();

    const result = await registry.probe(target());
    expect(result).toMatchObject({
      healthy: true,
      status: 'healthy',
      identity: { model: 'claude-observed', protocol: 'anthropic' },
      capabilities: {
        authenticated: true,
        structuredOutput: true,
        metadataOnly: true,
        toolsEnabled: false,
        fileInputEnabled: false,
        sourceCodeInputEnabled: false,
        allowedPurposes: ['weekly_report'],
      },
    });
    expect(result.capabilities.capabilitySnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(generate.mock.calls[0]![0])).not.toContain('tools');
  });

  it('区分缺配置、无效凭证和供应商不可用，不能仅保存字符串就标健康', async () => {
    const registry = new IntegrationProbeRegistry();
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new DomainError('AI_CREDENTIAL_INVALID', 'AI API Key 无效', { httpStatus: 401 }),
      )
      .mockRejectedValueOnce(
        new DomainError('AI_PROVIDER_RESPONSE_ERROR', 'AI 暂不可用', {
          httpStatus: 503,
          retryable: true,
        }),
      );
    const probe = new AiProbeService(registry, { generate } as unknown as AiProviderClient);
    probe.onModuleInit();

    await expect(
      registry.probe({ ...target(), baseUrl: null, credential: null }),
    ).resolves.toMatchObject({ status: 'configuration_required', healthy: false });
    await expect(registry.probe(target())).resolves.toMatchObject({
      status: 'invalid',
      errorCode: 'AI_CREDENTIAL_INVALID',
    });
    await expect(registry.probe(target())).resolves.toMatchObject({
      status: 'degraded',
      errorCode: 'AI_PROVIDER_RESPONSE_ERROR',
    });
  });

  function target() {
    return {
      id: 'ai-1',
      type: 'ai' as const,
      baseUrl: 'https://api.anthropic.example',
      credential: { apiKey: 'provider-secret-value' },
      config: {
        protocol: 'anthropic',
        model: 'claude-test',
        metadataOnly: true,
        timeoutMs: 20_000,
        maxInputTokens: 32_000,
        maxOutputTokens: 1_024,
        temperaturePolicy: 'deterministic',
        temperature: 0,
        allowedPurposes: ['weekly_report'],
      },
    };
  }
});
