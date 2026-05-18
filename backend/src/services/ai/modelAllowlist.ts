import { getEnv } from '../../config/env.js';
import type { AIKeyProvider } from './user-ai-keys.js';

export const DEFAULT_ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

/**
 * OpenAI model allowlist — promoted in P1a alongside the runtime client.
 * The picker, API validation, and `getAllKnownModels()` now accept these.
 */
export const DEFAULT_OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
];

export const RECOMMENDED_MODELS: Record<AIKeyProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o',
};

/** @deprecated Use getScribeModelAllowlistByProvider instead */
export const DEFAULT_SCRIBE_MODELS = DEFAULT_ANTHROPIC_MODELS;

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
 *
 * P1a: OpenAI now returns DEFAULT_OPENAI_MODELS — the runtime client is
 * wired in createAIService and the picker treats the list normally.
 */
export function getScribeModelAllowlistByProvider(provider?: AIKeyProvider): string[] {
  const env = getEnv();
  if (env.AI_SCRIBE_MODEL_ALLOWLIST) {
    return env.AI_SCRIBE_MODEL_ALLOWLIST.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (provider === 'anthropic') {
    return DEFAULT_ANTHROPIC_MODELS;
  }
  if (provider === 'openai') {
    return DEFAULT_OPENAI_MODELS;
  }
  return DEFAULT_ANTHROPIC_MODELS;
}

/**
 * Combined allowlist across every supported provider — used by the per-chat
 * model picker (issue #437) to validate PATCH /api/pipelines/:id/model.
 *
 * P1a: includes OpenAI alongside Anthropic now that the runtime client is
 * active. PATCH /api/pipelines/:id/model accepts either provider's models.
 */
export function getAllKnownModels(): string[] {
  return [...DEFAULT_ANTHROPIC_MODELS, ...DEFAULT_OPENAI_MODELS];
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
 * OpenAI models start with "gpt-", "o1", etc.
 */
export function detectProviderFromModel(model: string): AIKeyProvider | null {
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('text-') ||
    model.startsWith('davinci')
  ) {
    return 'openai';
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

  return modelProvider === provider;
}
