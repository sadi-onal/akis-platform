import { getEnv } from '../../config/env.js';
import type { AIKeyProvider } from './user-ai-keys.js';

/**
 * Runtime AI provider — historically wider than {@link AIKeyProvider} when
 * Gemini lived only at the AIService runtime layer. P12 promoted 'google'
 * into {@link AIKeyProvider} (DB enum + Settings UI), so this alias is now
 * structurally identical to {@link AIKeyProvider}. Kept as a distinct name
 * because allowlist / model-dispatch call sites read more clearly with it.
 */
export type RuntimeAIProvider = AIKeyProvider;

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

/**
 * Google Gemini model allowlist (P1c). Default trio covers the three
 * common tiers: fast/cheap (flash-8b), balanced (flash), strong (pro).
 * Model IDs are the bare Google AI Studio identifiers used in the
 * `:generateContent` REST endpoint URL.
 */
export const DEFAULT_GOOGLE_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];

export const RECOMMENDED_MODELS: Record<RuntimeAIProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o',
  google: 'gemini-1.5-flash',
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
 * P1a: OpenAI returns DEFAULT_OPENAI_MODELS — runtime client active.
 * P1c: 'google' returns the Gemini default trio.
 */
export function getScribeModelAllowlistByProvider(provider?: RuntimeAIProvider): string[] {
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
  if (provider === 'google') {
    return DEFAULT_GOOGLE_MODELS;
  }
  return DEFAULT_ANTHROPIC_MODELS;
}

/**
 * Combined allowlist across every supported provider — used by the per-chat
 * model picker (issue #437) to validate PATCH /api/pipelines/:id/model.
 *
 * P1a: includes OpenAI alongside Anthropic now that the runtime client is
 * active. P1c: includes Google Gemini. PATCH /api/pipelines/:id/model
 * accepts any of the three providers' models.
 */
export function getAllKnownModels(): string[] {
  return [...DEFAULT_ANTHROPIC_MODELS, ...DEFAULT_OPENAI_MODELS, ...DEFAULT_GOOGLE_MODELS];
}

/** Returns the recommended default model for a given AI provider. */
export function getRecommendedModel(provider: RuntimeAIProvider): string {
  return RECOMMENDED_MODELS[provider];
}

/** Checks whether a model ID is in the given allowlist. */
export function isModelAllowed(model: string, allowlist: string[]): boolean {
  return allowlist.includes(model);
}

/**
 * Check if a model ID looks like it belongs to a specific provider.
 * OpenAI models start with "gpt-", "o1", etc.
 * P1c: Gemini models match the `gemini-` prefix.
 */
export function detectProviderFromModel(model: string): RuntimeAIProvider | null {
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
  if (model.startsWith('gemini-')) {
    return 'google';
  }
  return null;
}

/**
 * Validate that a model is compatible with a provider.
 * Returns true if model can be used with the provider.
 */
export function isModelCompatibleWithProvider(
  model: string,
  provider: RuntimeAIProvider,
): boolean {
  const modelProvider = detectProviderFromModel(model);

  // Unknown model format - allow it (could be a new model)
  if (modelProvider === null) {
    return true;
  }

  return modelProvider === provider;
}
