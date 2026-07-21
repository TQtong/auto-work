import type { Integration } from '../api/types.js';

export type AiProtocol = 'openai_compatible' | 'anthropic' | 'gemini';

export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'openrouter'
  | 'volcengine'
  | 'siliconflow'
  | 'custom';

export interface AiProviderDefinition {
  id: AiProviderId;
  name: string;
  description: string;
  mark: string;
  color: string;
  protocol: AiProtocol;
  baseUrl: string;
  models: Array<{ value: string; label: string }>;
  custom: boolean;
}

export interface AiProviderFormValues {
  provider: AiProviderId;
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperaturePolicy: 'deterministic' | 'provider_default';
  temperature: number;
  allowedPurposes: Array<
    'weekly_report' | 'evidence_suggestion' | 'quarterly_review' | 'score_suggestion'
  >;
}

export const aiProviderCatalog: AiProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT 系列模型',
    mark: 'O',
    color: '#10a37f',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { value: 'gpt-5.2', label: 'GPT-5.2' },
      { value: 'gpt-5-mini', label: 'GPT-5 mini' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    ],
    custom: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude 系列模型',
    mark: 'A',
    color: '#d97757',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    custom: false,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini 原生 API',
    mark: 'G',
    color: '#4285f4',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: [
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    custom: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 官方 API',
    mark: 'D',
    color: '#4d6bfe',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ],
    custom: false,
  },
  {
    id: 'qwen',
    name: '通义千问',
    description: '阿里云百炼 OpenAI 兼容接口',
    mark: 'Q',
    color: '#615ced',
    protocol: 'openai_compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { value: 'qwen3.7-max', label: 'Qwen 3.7 Max' },
      { value: 'qwen3.6-plus', label: 'Qwen 3.6 Plus' },
      { value: 'qwen3.6-flash', label: 'Qwen 3.6 Flash' },
    ],
    custom: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '统一访问多家模型',
    mark: 'OR',
    color: '#6d5dfc',
    protocol: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { value: 'openai/gpt-5.2', label: 'OpenAI / GPT-5.2' },
      { value: 'anthropic/claude-sonnet-4.6', label: 'Anthropic / Claude Sonnet 4.6' },
      { value: 'google/gemini-3.5-flash', label: 'Google / Gemini 3.5 Flash' },
    ],
    custom: false,
  },
  {
    id: 'volcengine',
    name: '火山引擎方舟',
    description: '豆包及方舟模型服务',
    mark: 'V',
    color: '#165dff',
    protocol: 'openai_compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { value: 'doubao-seed-2-0-lite-260215', label: 'Doubao Seed 2.0 Lite' },
      { value: 'doubao-seed-2-0-pro-260215', label: 'Doubao Seed 2.0 Pro' },
      { value: 'doubao-seed-2-0-code', label: 'Doubao Seed 2.0 Code' },
    ],
    custom: false,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    description: 'SiliconCloud 多模型服务',
    mark: 'SF',
    color: '#111827',
    protocol: 'openai_compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { value: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2' },
      { value: 'Pro/deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2 Pro' },
      { value: 'Pro/zai-org/GLM-4.7', label: 'GLM-4.7 Pro' },
    ],
    custom: false,
  },
  {
    id: 'custom',
    name: '自定义供应商',
    description: 'OpenAI-compatible、Anthropic 或 Gemini',
    mark: '+',
    color: '#64748b',
    protocol: 'openai_compatible',
    baseUrl: '',
    models: [],
    custom: true,
  },
];

export function aiProviderById(id: string | undefined): AiProviderDefinition {
  return aiProviderCatalog.find((provider) => provider.id === id) ?? aiProviderCatalog.at(-1)!;
}

export function aiProviderIdFromIntegration(integration: Integration): AiProviderId {
  const configured = integration.config.provider;
  if (typeof configured === 'string' && aiProviderCatalog.some((item) => item.id === configured)) {
    return configured as AiProviderId;
  }
  const match = aiProviderCatalog.find(
    (provider) => !provider.custom && provider.baseUrl === integration.baseUrl,
  );
  return match?.id ?? 'custom';
}

export function defaultAiProviderValues(provider: AiProviderDefinition): AiProviderFormValues {
  const firstModel = provider.models[0]?.value ?? '';
  return {
    provider: provider.id,
    name: provider.custom ? '' : provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    model: firstModel,
    apiKey: '',
    timeoutMs: 60_000,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    temperaturePolicy: 'deterministic',
    temperature: 0,
    allowedPurposes: ['weekly_report'],
  };
}

export function toAiProviderPayload(values: AiProviderFormValues) {
  return {
    type: 'ai' as const,
    name: values.name,
    baseUrl: values.baseUrl,
    config: {
      provider: values.provider,
      protocol: values.protocol,
      model: values.model,
      metadataOnly: true as const,
      timeoutMs: values.timeoutMs,
      maxInputTokens: values.maxInputTokens,
      maxOutputTokens: values.maxOutputTokens,
      temperaturePolicy: values.temperaturePolicy,
      temperature: values.temperature,
      allowedPurposes: values.allowedPurposes,
    },
    credential: { apiKey: values.apiKey },
  };
}
