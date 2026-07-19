import { Injectable, OnModuleInit } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import { requestHash } from '@auto-work/domain';
import {
  IntegrationProbeRegistry,
  type IntegrationProbe,
  type ProbeResult,
  type ProbeTarget,
} from '../integrations/integration-probe.registry.js';
import { aiProviderConfigSchema } from './ai-provider.config.js';
import { AiProviderClient } from './ai-provider.client.js';

const probeOutputSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, echo: { type: 'string' } },
  required: ['ok', 'echo'],
  additionalProperties: false,
};

@Injectable()
export class AiProbeService implements IntegrationProbe, OnModuleInit {
  public readonly type = 'ai' as const;

  public constructor(
    private readonly registry: IntegrationProbeRegistry,
    private readonly client: AiProviderClient,
  ) {}

  public onModuleInit(): void {
    this.registry.register(this);
  }

  public async probe(target: ProbeTarget): Promise<ProbeResult> {
    if (!target.baseUrl || !target.credential?.apiKey) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: { adapterRegistered: true, authenticated: false, toolsEnabled: false },
        errorCode: 'AI_CONFIGURATION_REQUIRED',
        message: 'AI 基础地址、协议、模型和 API Key 均为必填项',
      };
    }
    const parsed = aiProviderConfigSchema.safeParse(target.config);
    if (!parsed.success) {
      return {
        healthy: false,
        status: 'configuration_required',
        capabilities: { adapterRegistered: true, authenticated: false, toolsEnabled: false },
        errorCode: 'AI_CONFIGURATION_INVALID',
        message: 'AI 非秘密配置不完整或超出允许范围',
      };
    }
    try {
      const response = await this.client.generate({
        baseUrl: target.baseUrl,
        apiKey: target.credential.apiKey,
        config: parsed.data,
        request: {
          purpose: parsed.data.allowedPurposes[0]!,
          systemPrompt:
            '你是连接测试器。不得调用工具，不得复述输入，只返回符合 JSON Schema 的固定结果。',
          userPrompt: '返回 {"ok":true,"echo":"AUTO_WORK_AI_PROBE"}',
          outputSchema: probeOutputSchema,
          maxOutputTokens: 128,
          temperature: 0,
        },
      });
      let output: unknown;
      try {
        output = JSON.parse(response.outputText) as unknown;
      } catch {
        throw new DomainError('AI_PROBE_OUTPUT_INVALID', 'AI 连接测试未返回合法 JSON', {
          httpStatus: 502,
        });
      }
      if (
        !output ||
        typeof output !== 'object' ||
        (output as Record<string, unknown>).ok !== true ||
        (output as Record<string, unknown>).echo !== 'AUTO_WORK_AI_PROBE'
      ) {
        throw new DomainError('AI_PROBE_OUTPUT_INVALID', 'AI 连接测试结构化结果不符合约定', {
          httpStatus: 502,
        });
      }
      return {
        healthy: true,
        status: 'healthy',
        identity: { model: response.model, protocol: response.protocol },
        capabilities: {
          adapterRegistered: true,
          authenticated: true,
          protocol: response.protocol,
          configuredModel: parsed.data.model,
          observedModel: response.model,
          structuredOutput: true,
          usageReported: Object.values(response.usage).some((value) => value !== null),
          stopReason: response.stopReason,
          metadataOnly: true,
          toolsEnabled: false,
          fileInputEnabled: false,
          sourceCodeInputEnabled: false,
          allowedPurposes: parsed.data.allowedPurposes,
          capabilitySnapshotHash: requestHash({
            protocol: response.protocol,
            configuredModel: parsed.data.model,
            observedModel: response.model,
            structuredOutput: true,
            metadataOnly: true,
            toolsEnabled: false,
            allowedPurposes: parsed.data.allowedPurposes,
          }),
        },
      };
    } catch (error) {
      const domainError = error as DomainError;
      return {
        healthy: false,
        status: ['AI_CREDENTIAL_INVALID', 'AI_PERMISSION_DENIED'].includes(domainError.code)
          ? 'invalid'
          : 'degraded',
        capabilities: {
          adapterRegistered: true,
          authenticated: false,
          protocol: parsed.data.protocol,
          configuredModel: parsed.data.model,
          metadataOnly: true,
          toolsEnabled: false,
        },
        errorCode: domainError.code ?? 'AI_PROBE_FAILED',
        message: domainError.message,
      };
    }
  }
}
