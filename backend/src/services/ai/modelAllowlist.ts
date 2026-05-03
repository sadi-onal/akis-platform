import { getEnv } from '../../config/env.js';
import type { AIKeyProvider } from './user-ai-keys.js';

export const DEFAULT_ANTHROPIC_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
];

/**
 * OpenAI model allowlist — kept untouched in PR-A (per the user's "don't
 * touch OpenAI" directive) so PR-B B5 can wire up the runtime client and
 * promote the list. PR-A explicitly EXCLUDES OpenAI from
 * `getAllKnownModels()` so the picker / API validation rejects them today
 * even though the array exists.
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
 * Note: OpenAI returns an empty array in PR-A — there's no runtime client
 * yet (see PR-B B5). Frontend treats empty as "provider not yet available"
 * and shows the disabled-tab UX.
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
    // PR-A: defensively empty until B5 adds the runtime client.
    return [];
  }
  return DEFAULT_ANTHROPIC_MODELS;
}

/**
 * Combined allowlist across every supported provider — used by the per-chat
 * model picker (issue #437) to validate PATCH /api/pipelines/:id/model.
 *
 * PR-A: Anthropic-only. OpenAI models are deliberately excluded so a user
 * who somehow types one in gets rejected at the API boundary instead of
 * blowing up at runtime in AIService factory. PR-B B5 brings them back.
 */
export function getAllKnownModels(): string[] {
  return [...DEFAULT_ANTHROPIC_MODELS];
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
 * OpenAI models start with "gpt-", "o1", etc. — kept here because PR-B B5
 * needs the mapping; the runtime factory still rejects 'openai' until then.
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
