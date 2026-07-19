import { Injectable } from '@nestjs/common';
import { DomainError } from '@auto-work/contracts';
import type { SecureHttpResponse } from '../../infrastructure/http/secure-http.service.js';
import { SecureHttpService } from '../../infrastructure/http/secure-http.service.js';
import type {
  AiGenerationRequest,
  AiGenerationResponse,
  AiProviderConfig,
  AiProtocol,
  AiUsage,
} from './ai-provider.types.js';

interface GenerateInput {
  baseUrl: string;
  apiKey: string;
  config: AiProviderConfig;
  request: AiGenerationRequest;
}

@Injectable()
export class AiProviderClient {
  public constructor(private readonly http: SecureHttpService) {}

  public async generate(input: GenerateInput): Promise<AiGenerationResponse> {
    if (!input.config.allowedPurposes.includes(input.request.purpose)) {
      throw new DomainError('AI_PURPOSE_NOT_ALLOWED', '当前 AI 连接未允许该用途', {
        httpStatus: 403,
      });
    }
    const requestedMaxOutputTokens = input.request.maxOutputTokens ?? input.config.maxOutputTokens;
    if (!Number.isInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens < 1) {
      throw new DomainError('AI_OUTPUT_LIMIT_INVALID', 'AI 输出 Token 上限无效', {
        httpStatus: 422,
      });
    }
    const maxOutputTokens = Math.min(requestedMaxOutputTokens, input.config.maxOutputTokens);
    const temperature =
      input.request.temperature !== undefined
        ? input.request.temperature
        : input.config.temperaturePolicy === 'deterministic'
          ? input.config.temperature
          : null;
    if (
      temperature !== null &&
      (!Number.isFinite(temperature) || temperature < 0 || temperature > 1)
    ) {
      throw new DomainError('AI_TEMPERATURE_INVALID', 'AI 温度必须位于 0 到 1', {
        httpStatus: 422,
      });
    }
    const endpoint = this.endpoint(input.baseUrl, input.config.protocol, input.config.model);
    const base = new URL(input.baseUrl);
    const response = await this.http.postJson({
      url: endpoint,
      expectedHost: base.hostname,
      allowPrivateNetwork: false,
      timeoutMs: input.config.timeoutMs,
      headers: this.headers(input.config.protocol, input.apiKey),
      body: this.requestBody(input.config, input.request, maxOutputTokens, temperature),
    });
    if (response.status < 200 || response.status >= 300) throw this.statusError(response);
    return this.parseResponse(input.config.protocol, input.config.model, response);
  }

  public endpoint(baseUrl: string, protocol: AiProtocol, model: string): URL {
    const base = new URL(baseUrl);
    const prefix = base.pathname.replace(/\/+$/u, '');
    const hasVersionSuffix = /\/v\d+(?:beta\d*)?$/iu.test(prefix);
    const path =
      protocol === 'openai_compatible'
        ? `${prefix}${hasVersionSuffix ? '' : '/v1'}/chat/completions`
        : protocol === 'anthropic'
          ? `${prefix}${hasVersionSuffix ? '' : '/v1'}/messages`
          : `${prefix}${hasVersionSuffix ? '' : '/v1beta'}/models/${encodeURIComponent(
              model.replace(/^models\//u, ''),
            )}:generateContent`;
    return new URL(`${base.origin}${path}`);
  }

  private headers(protocol: AiProtocol, apiKey: string): Record<string, string> {
    if (protocol === 'openai_compatible') return { Authorization: `Bearer ${apiKey}` };
    if (protocol === 'anthropic') {
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    }
    return { 'x-goog-api-key': apiKey };
  }

  private requestBody(
    config: AiProviderConfig,
    request: AiGenerationRequest,
    maxOutputTokens: number,
    temperature: number | null,
  ): Record<string, unknown> {
    // 三种协议均不传 tools/tool_config，AI 在网络协议层就没有执行动作的表达能力。
    if (config.protocol === 'openai_compatible') {
      return {
        model: config.model,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        max_tokens: maxOutputTokens,
        ...(temperature === null ? {} : { temperature }),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'auto_work_output',
            strict: true,
            schema: request.outputSchema,
          },
        },
      };
    }
    if (config.protocol === 'anthropic') {
      return {
        model: config.model,
        max_tokens: maxOutputTokens,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
        ...(temperature === null ? {} : { temperature }),
        output_config: {
          format: { type: 'json_schema', schema: request.outputSchema },
        },
      };
    }
    return {
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      generationConfig: {
        maxOutputTokens,
        ...(temperature === null ? {} : { temperature }),
        responseMimeType: 'application/json',
        responseSchema: request.outputSchema,
      },
    };
  }

  private parseResponse(
    protocol: AiProtocol,
    configuredModel: string,
    response: SecureHttpResponse,
  ): AiGenerationResponse {
    const body = this.object(response.body, 'AI_PROVIDER_RESPONSE_INVALID');
    if (protocol === 'openai_compatible') {
      const choice = this.firstObject(body.choices, 'AI_PROVIDER_RESPONSE_INVALID');
      const message = this.object(choice.message, 'AI_PROVIDER_RESPONSE_INVALID');
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        throw new DomainError('AI_TOOL_OUTPUT_REJECTED', 'AI 返回了未授权工具调用', {
          httpStatus: 502,
        });
      }
      if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new DomainError('AI_PROVIDER_REFUSED', 'AI 提供商拒绝了本次请求', {
          httpStatus: 422,
        });
      }
      const stopReason = this.requiredString(
        choice.finish_reason,
        'AI_PROVIDER_STOP_REASON_MISSING',
      );
      if (stopReason !== 'stop') {
        throw new DomainError('AI_PROVIDER_OUTPUT_REJECTED', 'AI 输出被截断、拦截或包含动作', {
          httpStatus: 422,
        });
      }
      return {
        protocol,
        model: this.optionalString(body.model) ?? configuredModel,
        outputText: this.requiredString(message.content, 'AI_PROVIDER_OUTPUT_MISSING'),
        stopReason,
        providerRequestId: this.optionalString(body.id) ?? response.headers['x-request-id'] ?? null,
        usage: this.openAiUsage(body.usage),
      };
    }
    if (protocol === 'anthropic') {
      if (!Array.isArray(body.content)) {
        throw new DomainError('AI_PROVIDER_RESPONSE_INVALID', 'Anthropic content 结构无效', {
          httpStatus: 502,
        });
      }
      if (
        body.content.some(
          (item) =>
            this.isObject(item) && ['tool_use', 'server_tool_use'].includes(String(item.type)),
        )
      ) {
        throw new DomainError('AI_TOOL_OUTPUT_REJECTED', 'AI 返回了未授权工具调用', {
          httpStatus: 502,
        });
      }
      const outputText = body.content
        .filter(
          (item) => this.isObject(item) && item.type === 'text' && typeof item.text === 'string',
        )
        .map((item) => String((item as Record<string, unknown>).text))
        .join('');
      const stopReason = this.requiredString(body.stop_reason, 'AI_PROVIDER_STOP_REASON_MISSING');
      if (stopReason !== 'end_turn') {
        throw new DomainError('AI_PROVIDER_OUTPUT_REJECTED', 'AI 输出被拒绝、截断或包含动作', {
          httpStatus: 422,
        });
      }
      return {
        protocol,
        model: this.optionalString(body.model) ?? configuredModel,
        outputText: this.requiredString(outputText, 'AI_PROVIDER_OUTPUT_MISSING'),
        stopReason,
        providerRequestId: this.optionalString(body.id) ?? response.headers['request-id'] ?? null,
        usage: this.anthropicUsage(body.usage),
      };
    }
    const promptFeedback = this.optionalObject(body.promptFeedback);
    if (this.optionalString(promptFeedback?.blockReason)) {
      throw new DomainError('AI_PROVIDER_REFUSED', 'Gemini 提示词被安全策略拦截', {
        httpStatus: 422,
      });
    }
    const candidate = this.firstObject(body.candidates, 'AI_PROVIDER_OUTPUT_MISSING');
    const content = this.object(candidate.content, 'AI_PROVIDER_RESPONSE_INVALID');
    if (!Array.isArray(content.parts)) {
      throw new DomainError('AI_PROVIDER_RESPONSE_INVALID', 'Gemini parts 结构无效', {
        httpStatus: 502,
      });
    }
    if (
      content.parts.some(
        (part) => this.isObject(part) && ('functionCall' in part || 'executableCode' in part),
      )
    ) {
      throw new DomainError('AI_TOOL_OUTPUT_REJECTED', 'AI 返回了未授权工具或代码调用', {
        httpStatus: 502,
      });
    }
    const outputText = content.parts
      .filter((part) => this.isObject(part) && typeof part.text === 'string')
      .map((part) => String((part as Record<string, unknown>).text))
      .join('');
    const stopReason = this.requiredString(
      candidate.finishReason,
      'AI_PROVIDER_STOP_REASON_MISSING',
    );
    if (stopReason !== 'STOP') {
      throw new DomainError('AI_PROVIDER_OUTPUT_REJECTED', `Gemini 输出未正常结束：${stopReason}`, {
        httpStatus: 422,
      });
    }
    return {
      protocol,
      model: this.optionalString(body.modelVersion) ?? configuredModel,
      outputText: this.requiredString(outputText, 'AI_PROVIDER_OUTPUT_MISSING'),
      stopReason,
      providerRequestId:
        this.optionalString(body.responseId) ?? response.headers['x-request-id'] ?? null,
      usage: this.geminiUsage(body.usageMetadata),
    };
  }

  private statusError(response: SecureHttpResponse): DomainError {
    const requestId = response.headers['x-request-id'] ?? response.headers['request-id'] ?? null;
    const details = requestId ? { providerRequestId: requestId } : undefined;
    if (response.status >= 300 && response.status < 400) {
      return new DomainError('AI_REDIRECT_REJECTED', 'AI 提供商返回重定向，已按安全策略拒绝', {
        httpStatus: 502,
        details,
      });
    }
    if (response.status === 401) {
      return new DomainError('AI_CREDENTIAL_INVALID', 'AI API Key 无效', {
        httpStatus: 401,
        details,
      });
    }
    if (response.status === 403) {
      return new DomainError('AI_PERMISSION_DENIED', 'AI API Key 无权使用该模型或端点', {
        httpStatus: 403,
        details,
      });
    }
    if (response.status === 404) {
      return new DomainError('AI_MODEL_OR_ENDPOINT_NOT_FOUND', 'AI 模型或端点不存在', {
        httpStatus: 422,
        details,
      });
    }
    if (response.status === 429) {
      return new DomainError('AI_RATE_LIMITED', 'AI 提供商触发频率或额度限制', {
        httpStatus: 503,
        retryable: true,
        details,
      });
    }
    return new DomainError('AI_PROVIDER_RESPONSE_ERROR', `AI 提供商返回 HTTP ${response.status}`, {
      httpStatus: response.status >= 500 ? 503 : 422,
      retryable: response.status >= 500,
      details,
    });
  }

  private openAiUsage(value: unknown): AiUsage {
    const usage = this.optionalObject(value);
    return this.usage(
      usage?.prompt_tokens,
      usage?.completion_tokens,
      usage?.total_tokens,
      this.optionalObject(usage?.prompt_tokens_details)?.cached_tokens,
      null,
    );
  }

  private anthropicUsage(value: unknown): AiUsage {
    const usage = this.optionalObject(value);
    const input = this.number(usage?.input_tokens);
    const cacheRead = this.number(usage?.cache_read_input_tokens);
    const cacheWrite = this.number(usage?.cache_creation_input_tokens);
    const output = this.number(usage?.output_tokens);
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens:
        input === null || output === null
          ? null
          : input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
  }

  private geminiUsage(value: unknown): AiUsage {
    const usage = this.optionalObject(value);
    return this.usage(
      usage?.promptTokenCount,
      usage?.candidatesTokenCount,
      usage?.totalTokenCount,
      usage?.cachedContentTokenCount,
      null,
    );
  }

  private usage(
    input: unknown,
    output: unknown,
    total: unknown,
    cacheRead: unknown,
    cacheWrite: unknown,
  ): AiUsage {
    return {
      inputTokens: this.number(input),
      outputTokens: this.number(output),
      totalTokens: this.number(total),
      cacheReadTokens: this.number(cacheRead),
      cacheWriteTokens: this.number(cacheWrite),
    };
  }

  private object(value: unknown, code: string): Record<string, unknown> {
    if (!this.isObject(value)) {
      throw new DomainError(code, 'AI 提供商响应结构无效', { httpStatus: 502 });
    }
    return value;
  }

  private optionalObject(value: unknown): Record<string, unknown> | null {
    return this.isObject(value) ? value : null;
  }

  private firstObject(value: unknown, code: string): Record<string, unknown> {
    if (!Array.isArray(value) || value.length === 0) {
      throw new DomainError(code, 'AI 提供商没有返回候选结果', { httpStatus: 502 });
    }
    return this.object(value[0], code);
  }

  private requiredString(value: unknown, code: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new DomainError(code, 'AI 提供商缺少必要文本字段', { httpStatus: 502 });
    }
    return value;
  }

  private optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private number(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
