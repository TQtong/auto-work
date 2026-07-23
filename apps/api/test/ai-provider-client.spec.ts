import { describe, expect, it, vi } from 'vitest';
import type { SecureHttpService } from '../src/infrastructure/http/secure-http.service.js';
import { AiProviderClient } from '../src/modules/ai/ai-provider.client.js';
import type {
  AiGenerationRequest,
  AiProviderConfig,
  AiProtocol,
} from '../src/modules/ai/ai-provider.types.js';

describe('AI 三协议适配器', () => {
  it.each([
    {
      protocol: 'openai_compatible' as const,
      baseUrl: 'https://api.openai.example/v1',
      expectedPath: '/v1/chat/completions',
      response: {
        status: 200,
        headers: { 'x-request-id': 'openai-request' },
        body: {
          id: 'chat-1',
          model: 'openai-model-observed',
          choices: [
            { finish_reason: 'stop', message: { content: '{"ok":true}', role: 'assistant' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      },
      expectedHeader: 'Authorization',
      expectedStop: 'stop',
      expectedUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    },
    {
      protocol: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.example',
      expectedPath: '/v1/messages',
      response: {
        status: 200,
        headers: { 'request-id': 'anthropic-request' },
        body: {
          id: 'message-1',
          model: 'anthropic-model-observed',
          content: [{ type: 'text', text: '{"ok":true}' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 11,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      },
      expectedHeader: 'x-api-key',
      expectedStop: 'end_turn',
      expectedUsage: { inputTokens: 11, outputTokens: 5, totalTokens: 21 },
    },
    {
      protocol: 'gemini' as const,
      baseUrl: 'https://generativelanguage.example/v1beta',
      expectedPath: '/v1beta/models/test-model%2Fstable:generateContent',
      response: {
        status: 200,
        headers: {},
        body: {
          responseId: 'gemini-request',
          modelVersion: 'gemini-model-observed',
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: '{"ok":true}' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 6,
            totalTokenCount: 18,
          },
        },
      },
      expectedHeader: 'x-goog-api-key',
      expectedStop: 'STOP',
      expectedUsage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
    },
  ])(
    '按 $protocol 构造鉴权、结构化输出、usage 和停止原因',
    async ({
      protocol,
      baseUrl,
      expectedPath,
      response,
      expectedHeader,
      expectedStop,
      expectedUsage,
    }) => {
      const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue(response);
      const client = new AiProviderClient({ postJson } as unknown as SecureHttpService);
      const result = await client.generate({
        baseUrl,
        apiKey: 'provider-secret-value',
        config: config(protocol, protocol === 'gemini' ? 'models/test-model/stable' : 'test-model'),
        request: request(),
      });

      expect(postJson).toHaveBeenCalledOnce();
      const call = postJson.mock.calls[0]![0];
      expect(call.url.pathname).toBe(expectedPath);
      expect(call.expectedHost).toBe(new URL(baseUrl).hostname);
      expect(call.allowPrivateNetwork).toBe(false);
      expect(call.timeoutMs).toBe(20_000);
      expect(call.headers?.[expectedHeader]).toContain('provider-secret-value');
      expect(JSON.stringify(call.body)).not.toContain('tools');
      expect(JSON.stringify(call.body)).not.toContain('provider-secret-value');
      if (protocol === 'openai_compatible') {
        expect(call.body).toMatchObject({
          response_format: { type: 'json_schema', json_schema: { strict: true } },
        });
      } else if (protocol === 'anthropic') {
        expect(call.body).toMatchObject({
          output_config: { format: { type: 'json_schema' } },
        });
      } else {
        expect(call.body).toMatchObject({
          generationConfig: { responseMimeType: 'application/json' },
        });
      }
      expect(result).toMatchObject({
        protocol,
        outputText: '{"ok":true}',
        stopReason: expectedStop,
        usage: expectedUsage,
      });
    },
  );

  it('硅基流动使用其支持的 JSON Object 结构化输出格式', async () => {
    const postJson = vi.fn<SecureHttpService['postJson']>().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      },
    });
    const client = new AiProviderClient({ postJson } as unknown as SecureHttpService);

    await client.generate({
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'provider-secret-value',
      config: { ...config('openai_compatible'), provider: 'siliconflow' },
      request: request(),
    });

    expect(postJson.mock.calls[0]![0].body).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(postJson.mock.calls[0]![0].body).not.toHaveProperty('response_format.json_schema');
    expect(JSON.stringify(postJson.mock.calls[0]![0].body)).toContain('\\"required\\":[\\"ok\\"]');
  });

  it.each([
    [301, 'AI_REDIRECT_REJECTED'],
    [401, 'AI_CREDENTIAL_INVALID'],
    [403, 'AI_PERMISSION_DENIED'],
    [404, 'AI_MODEL_OR_ENDPOINT_NOT_FOUND'],
    [429, 'AI_RATE_LIMITED'],
    [503, 'AI_PROVIDER_RESPONSE_ERROR'],
  ])('把 HTTP %i 转换为稳定错误 %s 且不回显供应商正文', async (status, code) => {
    const postJson = vi.fn().mockResolvedValue({
      status,
      headers: { 'x-request-id': 'request-id' },
      body: { error: { message: 'secret-value-should-not-leak' } },
    });
    const client = new AiProviderClient({ postJson } as unknown as SecureHttpService);
    await expect(
      client.generate({
        baseUrl: 'https://api.example/v1',
        apiKey: 'provider-secret-value',
        config: config('openai_compatible'),
        request: request(),
      }),
    ).rejects.toMatchObject({ code });
    await client
      .generate({
        baseUrl: 'https://api.example/v1',
        apiKey: 'provider-secret-value',
        config: config('openai_compatible'),
        request: request(),
      })
      .catch((error: Error) => expect(error.message).not.toContain('secret-value-should-not-leak'));
  });

  it('拒绝协议返回的工具调用、截断结果和未授权用途', async () => {
    const postJson = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: '{}', tool_calls: [{ id: 'forbidden' }] },
          },
        ],
      },
    });
    const client = new AiProviderClient({ postJson } as unknown as SecureHttpService);
    await expect(
      client.generate({
        baseUrl: 'https://api.example/v1',
        apiKey: 'provider-secret-value',
        config: config('openai_compatible'),
        request: request(),
      }),
    ).rejects.toMatchObject({ code: 'AI_TOOL_OUTPUT_REJECTED' });
    postJson.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: {
        choices: [{ finish_reason: 'length', message: { content: '{"ok":' } }],
      },
    });
    await expect(
      client.generate({
        baseUrl: 'https://api.example/v1',
        apiKey: 'provider-secret-value',
        config: config('openai_compatible'),
        request: request(),
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_OUTPUT_REJECTED' });
    await expect(
      client.generate({
        baseUrl: 'https://api.example/v1',
        apiKey: 'provider-secret-value',
        config: { ...config('openai_compatible'), allowedPurposes: ['quarterly_review'] },
        request: request(),
      }),
    ).rejects.toMatchObject({ code: 'AI_PURPOSE_NOT_ALLOWED' });
  });

  function config(protocol: AiProtocol, model = 'test-model'): AiProviderConfig {
    return {
      protocol,
      model,
      metadataOnly: true,
      timeoutMs: 20_000,
      maxInputTokens: 32_000,
      maxOutputTokens: 1_024,
      temperaturePolicy: 'deterministic',
      temperature: 0,
      allowedPurposes: ['weekly_report'],
    };
  }

  function request(): AiGenerationRequest {
    return {
      purpose: 'weekly_report',
      systemPrompt: '只返回事实',
      userPrompt: '生成结构化结果',
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    };
  }
});
