export type AiProtocol = 'openai_compatible' | 'anthropic' | 'gemini';

export type AiPurpose =
  'weekly_report' | 'evidence_suggestion' | 'quarterly_review' | 'score_suggestion';

export interface AiProviderConfig {
  provider?: string;
  protocol: AiProtocol;
  model: string;
  metadataOnly: true;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperaturePolicy: 'deterministic' | 'provider_default';
  temperature: number;
  allowedPurposes: AiPurpose[];
}

export interface AiGenerationRequest {
  purpose: AiPurpose;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number | null;
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface AiGenerationResponse {
  protocol: AiProtocol;
  model: string;
  outputText: string;
  stopReason: string;
  providerRequestId: string | null;
  usage: AiUsage;
}
