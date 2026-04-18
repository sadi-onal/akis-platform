import { getEnv } from '../../config/env.js';
import type { AIKeyProvider } from './user-ai-keys.js';

export const DEFAULT_ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
];

export const DEFAULT_OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
];

export const DEFAULT_OPENROUTER_MODELS = [
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.5-flash',
  'meta-llama/llama-4-maverick',
  'deepseek/deepseek-chat-v3-0324',
];

export const RECOMMENDED_MODELS: Record<AIKeyProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  openrouter: 'anthropic/claude-3.5-haiku',
};

/** @deprecated Use getScribeModelAllowlistByProvider instead */
export const DEFAULT_SCRIBE_MODELS = DEFAULT_OPENAI_MODELS;

/** Returns the Scribe model allowlist from env override or defaults. */
export function getScribeModelAllowlist(): string[] {
  const env = getEnv();
  if (env.AI_SCRIBE_MODEL_ALLOWLIST) {
    return env.AI_SCRIBE_MODEL_ALLOWLIST.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return DEFAULT_SCRIBE_MODELS;
}

/**
 * Get allowed models for a specific provider.
 * Env override applies to all providers (comma-separated list).
 */
export function getScribeModelAllowlistByProvider(provider?: AIKeyProvider): string[] {
  const env = getEnv();
  if (env.AI_SCRIBE_MODEL_ALLOWLIST) {
    return env.AI_SCRIBE_MODEL_ALLOWLIST.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (provider === 'openrouter') {
    return DEFAULT_OPENROUTER_MODELS;
  }
  if (provider === 'anthropic') {
    return DEFAULT_ANTHROPIC_MODELS;
  }
  return DEFAULT_OPENAI_MODELS;
}

/**
 * Combined allowlist across every provider — used by the per-chat model
 * picker (issue #437) to validate PATCH /api/pipelines/:id/model input
 * without the caller having to know which provider the pipeline is bound
 * to. Any model that appears in _any_ provider's default list is accepted;
 * provider compatibility is then a client-side gating concern based on
 * which provider keys the user has configured.
 */
export function getAllKnownModels(): string[] {
  return [
    ...DEFAULT_ANTHROPIC_MODELS,
    ...DEFAULT_OPENAI_MODELS,
    ...DEFAULT_OPENROUTER_MODELS,
  ];
}

/** Returns the recommended default model for a given AI provider. */
export function getRecommendedModel(provider: AIKeyProvider): string {
  return RECOMMENDED_MODELS[provider];
}

/** Checks whether a model ID is in the given allowlist. */
export function isModelAllowed(model: string, allowlist: string[]): boolean {
  return allowlist.includes(model);
}

/**
 * Check if a model ID looks like it belongs to a specific provider.
 * OpenRouter models typically have "org/model" format or ":free"/":nitro" suffix.
 * OpenAI models start with "gpt-", "o1", "text-", "davinci", etc.
 */
export function detectProviderFromModel(model: string): AIKeyProvider | null {
  if (model.startsWith('gpt-') || model.startsWith('o1') || 
      model.startsWith('o3') || model.startsWith('text-') || 
      model.startsWith('davinci')) {
    return 'openai';
  }
  if (model.includes('/') || model.includes(':free') || model.includes(':nitro')) {
    return 'openrouter';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  return null;
}

/**
 * Validate that a model is compatible with a provider.
 * Returns true if model can be used with the provider.
 */
export function isModelCompatibleWithProvider(model: string, provider: AIKeyProvider): boolean {
  const modelProvider = detectProviderFromModel(model);
  
  // Unknown model format - allow it (could be a new model)
  if (modelProvider === null) {
    return true;
  }
  
  // OpenRouter can proxy OpenAI models
  if (provider === 'openrouter') {
    return true;
  }
  
  // OpenAI can only use OpenAI models
  return modelProvider === provider;
}
