export type ModelPricing = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

/**
 * AI model pricing map — covers Anthropic, OpenAI, and OpenRouter models.
 * Prices in USD per 1 million tokens (as of April 2026).
 *
 * Source: https://anthropic.com/pricing, https://openai.com/pricing
 */
const PRICING_MAP: Record<string, ModelPricing> = {
  // ─── Anthropic Claude ──────────────────────────
  'claude-sonnet-4-6':          { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00 },
  'claude-sonnet-4-20250514':   { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00 },
  'claude-haiku-4-5':           { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },
  'claude-haiku-4-5-20251001':  { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },
  'claude-opus-4-20250514':     { inputUsdPer1M: 15.00, outputUsdPer1M: 75.00 },
  'claude-3-5-sonnet-20241022': { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00 },
  'claude-3-5-haiku-20241022':  { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },

  // ─── OpenRouter (Anthropic via proxy) ──────────
  'anthropic/claude-3.5-sonnet':  { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00 },
  'anthropic/claude-3.5-haiku':   { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },
  'anthropic/claude-3-opus':      { inputUsdPer1M: 15.00, outputUsdPer1M: 75.00 },

  // ─── OpenAI ────────────────────────────────────
  'gpt-4o-mini':    { inputUsdPer1M: 0.15,  outputUsdPer1M: 0.60 },
  'gpt-4o':         { inputUsdPer1M: 5.00,  outputUsdPer1M: 15.00 },
  'gpt-4.1-mini':   { inputUsdPer1M: 0.30,  outputUsdPer1M: 1.20 },
  'gpt-4.1':        { inputUsdPer1M: 2.00,  outputUsdPer1M: 8.00 },
  'gpt-4.1-nano':   { inputUsdPer1M: 0.10,  outputUsdPer1M: 0.40 },
  'o3-mini':        { inputUsdPer1M: 1.10,  outputUsdPer1M: 4.40 },
};

/**
 * Model alias map — resolves internal model names to canonical pricing keys.
 */
const MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/**
 * Returns pricing info for an AI model, resolving aliases automatically.
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Direct lookup
  if (PRICING_MAP[model]) return PRICING_MAP[model];

  // Alias resolution
  const canonical = MODEL_ALIASES[model];
  if (canonical && PRICING_MAP[canonical]) return PRICING_MAP[canonical];

  // Prefix match — handles versioned model names (e.g. claude-haiku-4-5-20251001-v2)
  for (const [key, pricing] of Object.entries(PRICING_MAP)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }

  return null;
}

/**
 * Anthropic prompt-caching price multipliers (issue #436).
 *
 * - Writing a prefix into the cache costs 1.25x normal input tokens.
 * - Reading a prefix from the cache costs 0.10x normal input tokens.
 *
 * These ratios are uniform across Claude 3.5 / 4.x families as of 2025-2026.
 * Non-Anthropic providers don't expose cache tokens, so the multipliers are
 * never applied in practice (cacheCreation/Read default to 0).
 */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.10;

/**
 * Estimates the USD cost for a given model and token counts.
 * Returns cost with 6 decimal places, or null if model pricing unknown.
 *
 * Prompt caching (issue #436): when `cacheCreationInputTokens` or
 * `cacheReadInputTokens` are provided, the base `inputTokens` count should
 * already EXCLUDE them — Anthropic's `usage.input_tokens` counts only the
 * fresh (non-cached, non-cache-write) prefix. We price the cache pools
 * separately against the model's input price to avoid double-counting.
 */
export function estimateCostUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number,
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const cacheWrite = cacheCreationInputTokens ?? 0;
  const cacheRead = cacheReadInputTokens ?? 0;

  const cost =
    (input / 1_000_000) * pricing.inputUsdPer1M +
    (output / 1_000_000) * pricing.outputUsdPer1M +
    (cacheWrite / 1_000_000) * pricing.inputUsdPer1M * ANTHROPIC_CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1_000_000) * pricing.inputUsdPer1M * ANTHROPIC_CACHE_READ_MULTIPLIER;
  return Number(cost.toFixed(6));
}

/**
 * Per-model total context-window size in tokens. Used by the chat token gauge
 * (issue #438) to compute "X / Y tokens · %Z" and to drive threshold colors.
 *
 * Sources: Anthropic & OpenAI model docs (as of April 2026). Long-context
 * GPT-4.1 family uses 1,047,576 (1M) which the API actually reports.
 */
const CONTEXT_WINDOW_MAP: Record<string, number> = {
  'claude-sonnet-4-6':          200_000,
  'claude-sonnet-4-20250514':   200_000,
  'claude-haiku-4-5':           200_000,
  'claude-haiku-4-5-20251001':  200_000,
  'claude-opus-4-20250514':     200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022':  200_000,

  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.5-haiku':  200_000,
  'anthropic/claude-3-opus':     200_000,

  'gpt-4o-mini':   128_000,
  'gpt-4o':        128_000,
  'gpt-4.1':       1_047_576,
  'gpt-4.1-mini':  1_047_576,
  'gpt-4.1-nano':  1_047_576,
  'o3-mini':       200_000,
};

/** Fallback context window when the model is unknown — conservative (GPT-4o class). */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Returns the total context-window size (in tokens) for the given model,
 * reusing the same alias + prefix-match resolution as pricing. Falls back
 * to {@link DEFAULT_CONTEXT_WINDOW} when the model is unknown.
 */
export function getContextWindow(model: string): number {
  if (CONTEXT_WINDOW_MAP[model]) return CONTEXT_WINDOW_MAP[model];

  const canonical = MODEL_ALIASES[model];
  if (canonical && CONTEXT_WINDOW_MAP[canonical]) return CONTEXT_WINDOW_MAP[canonical];

  for (const [key, window] of Object.entries(CONTEXT_WINDOW_MAP)) {
    if (model.startsWith(key) || key.startsWith(model)) return window;
  }

  return DEFAULT_CONTEXT_WINDOW;
}
