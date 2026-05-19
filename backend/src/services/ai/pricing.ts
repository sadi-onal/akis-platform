export type ModelPricing = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  /**
   * Optional explicit cache pricing in USD per 1M tokens. When present, takes
   * precedence over the multiplier-based fallback. Currently used for Claude
   * models where the doc spells out an exact 5m-write / 1h-write / read rate.
   */
  cacheWrite5mUsdPer1M?: number;
  cacheWrite1hUsdPer1M?: number;
  cacheReadUsdPer1M?: number;
};

/**
 * AI model pricing map — covers Anthropic Claude, OpenAI, and Google Gemini.
 * Prices in USD per 1 million tokens.
 *
 * Sources (last verified 2026-05-19):
 *   - Claude:   https://platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI:   https://openai.com/api/pricing
 *   - Gemini:   https://ai.google.dev/gemini-api/docs/pricing
 *
 * Cache rate convention (Claude): 5m cache write = 1.25× base input, 1h cache
 * write = 2× base input, cache read (hit) = 0.10× base input.
 */
const PRICING_MAP: Record<string, ModelPricing> = {
  // ─── Anthropic Claude · Opus 4.7 / 4.6 / 4.5 ───
  // $5 in · $25 out · 5m-write $6.25 · 1h-write $10 · read $0.50
  'claude-opus-4-7': {
    inputUsdPer1M: 5.0,
    outputUsdPer1M: 25.0,
    cacheWrite5mUsdPer1M: 6.25,
    cacheWrite1hUsdPer1M: 10.0,
    cacheReadUsdPer1M: 0.5,
  },
  'claude-opus-4-6': {
    inputUsdPer1M: 5.0,
    outputUsdPer1M: 25.0,
    cacheWrite5mUsdPer1M: 6.25,
    cacheWrite1hUsdPer1M: 10.0,
    cacheReadUsdPer1M: 0.5,
  },
  'claude-opus-4-5': {
    inputUsdPer1M: 5.0,
    outputUsdPer1M: 25.0,
    cacheWrite5mUsdPer1M: 6.25,
    cacheWrite1hUsdPer1M: 10.0,
    cacheReadUsdPer1M: 0.5,
  },

  // ─── Anthropic Claude · Opus 4.1 / 4 (deprecated) ───
  // $15 in · $75 out · 5m-write $18.75 · 1h-write $30 · read $1.50
  'claude-opus-4-1': {
    inputUsdPer1M: 15.0,
    outputUsdPer1M: 75.0,
    cacheWrite5mUsdPer1M: 18.75,
    cacheWrite1hUsdPer1M: 30.0,
    cacheReadUsdPer1M: 1.5,
  },
  'claude-opus-4': {
    inputUsdPer1M: 15.0,
    outputUsdPer1M: 75.0,
    cacheWrite5mUsdPer1M: 18.75,
    cacheWrite1hUsdPer1M: 30.0,
    cacheReadUsdPer1M: 1.5,
  },
  'claude-opus-4-20250514': {
    inputUsdPer1M: 15.0,
    outputUsdPer1M: 75.0,
    cacheWrite5mUsdPer1M: 18.75,
    cacheWrite1hUsdPer1M: 30.0,
    cacheReadUsdPer1M: 1.5,
  },

  // ─── Anthropic Claude · Sonnet 4.6 / 4.5 / 4 (deprecated) ───
  // $3 in · $15 out · 5m-write $3.75 · 1h-write $6 · read $0.30
  'claude-sonnet-4-6': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    cacheWrite5mUsdPer1M: 3.75,
    cacheWrite1hUsdPer1M: 6.0,
    cacheReadUsdPer1M: 0.3,
  },
  'claude-sonnet-4-5': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    cacheWrite5mUsdPer1M: 3.75,
    cacheWrite1hUsdPer1M: 6.0,
    cacheReadUsdPer1M: 0.3,
  },
  'claude-sonnet-4': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    cacheWrite5mUsdPer1M: 3.75,
    cacheWrite1hUsdPer1M: 6.0,
    cacheReadUsdPer1M: 0.3,
  },
  'claude-sonnet-4-20250514': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    cacheWrite5mUsdPer1M: 3.75,
    cacheWrite1hUsdPer1M: 6.0,
    cacheReadUsdPer1M: 0.3,
  },

  // ─── Anthropic Claude · Haiku 4.5 ───
  // $1 in · $5 out · 5m-write $1.25 · 1h-write $2 · read $0.10
  'claude-haiku-4-5': {
    inputUsdPer1M: 1.0,
    outputUsdPer1M: 5.0,
    cacheWrite5mUsdPer1M: 1.25,
    cacheWrite1hUsdPer1M: 2.0,
    cacheReadUsdPer1M: 0.1,
  },
  'claude-haiku-4-5-20251001': {
    inputUsdPer1M: 1.0,
    outputUsdPer1M: 5.0,
    cacheWrite5mUsdPer1M: 1.25,
    cacheWrite1hUsdPer1M: 2.0,
    cacheReadUsdPer1M: 0.1,
  },

  // ─── Anthropic Claude · Haiku 3.5 (retired) ───
  // $0.80 in · $4 out · 5m-write $1.00 · 1h-write $1.60 · read $0.08
  'claude-haiku-3-5': {
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 4.0,
    cacheWrite5mUsdPer1M: 1.0,
    cacheWrite1hUsdPer1M: 1.6,
    cacheReadUsdPer1M: 0.08,
  },
  'claude-3-5-haiku-20241022': {
    inputUsdPer1M: 0.8,
    outputUsdPer1M: 4.0,
    cacheWrite5mUsdPer1M: 1.0,
    cacheWrite1hUsdPer1M: 1.6,
    cacheReadUsdPer1M: 0.08,
  },
  'claude-3-5-sonnet-20241022': {
    inputUsdPer1M: 3.0,
    outputUsdPer1M: 15.0,
    cacheWrite5mUsdPer1M: 3.75,
    cacheWrite1hUsdPer1M: 6.0,
    cacheReadUsdPer1M: 0.3,
  },

  // ─── OpenRouter (Anthropic via proxy) ──────────
  'anthropic/claude-3.5-sonnet': { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  'anthropic/claude-3.5-haiku': { inputUsdPer1M: 0.8, outputUsdPer1M: 4.0 },
  'anthropic/claude-3-opus': { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },

  // ─── OpenAI ────────────────────────────────────
  'gpt-4o-mini': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'gpt-4o': { inputUsdPer1M: 5.0, outputUsdPer1M: 15.0 },
  'gpt-4-turbo': { inputUsdPer1M: 10.0, outputUsdPer1M: 30.0 },
  'gpt-4.1-mini': { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  'gpt-4.1': { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 },
  'gpt-4.1-nano': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  'o3-mini': { inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },

  // ─── Google Gemini ─────────────────────────────
  'gemini-1.5-pro': { inputUsdPer1M: 1.25, outputUsdPer1M: 5.0 },
  'gemini-1.5-flash': { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 },
  'gemini-2.0-flash': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
};

/**
 * Model alias map — resolves internal model names to canonical pricing keys.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Preserve historic mapping: the orchestrator's stored "claude-sonnet-4-6"
  // canonical id remains in the table directly, so no alias needed. We keep
  // explicit entries for the dated-suffix names callers may pass.
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

  // Prefix match — handles versioned model names (e.g. claude-haiku-4-5-20251001-v2).
  // Require a meaningful prefix length on both sides to avoid empty-string / very
  // short inputs matching the first table entry by accident.
  if (model.length >= 4) {
    for (const [key, pricing] of Object.entries(PRICING_MAP)) {
      if (model.startsWith(key) || key.startsWith(model)) return pricing;
    }
  }

  return null;
}

/**
 * Anthropic prompt-caching price multipliers (issue #436).
 *
 * Fallback factors used when a model entry doesn't spell out explicit
 * `cacheWrite5mUsdPer1M` / `cacheReadUsdPer1M`. The doc confirms these are
 * uniform across Claude families:
 *
 * - 5m cache write = 1.25× base input
 * - 1h cache write = 2×    base input
 * - Cache read     = 0.10× base input
 *
 * Non-Anthropic providers don't expose cache tokens, so the multipliers are
 * never applied in practice (cacheCreation/Read default to 0).
 */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;

/**
 * Estimates the USD cost for a given model and token counts.
 * Returns cost with 6 decimal places, or null if model pricing unknown.
 *
 * Prompt caching (issue #436): when `cacheCreationInputTokens` or
 * `cacheReadInputTokens` are provided, the base `inputTokens` count should
 * already EXCLUDE them — Anthropic's `usage.input_tokens` counts only the
 * fresh (non-cached, non-cache-write) prefix. We price the cache pools
 * separately against the model's input price to avoid double-counting.
 *
 * Cache tokens use the model's explicit `cacheWrite5mUsdPer1M` /
 * `cacheReadUsdPer1M` when present, otherwise fall back to the uniform
 * Anthropic multipliers (1.25× / 0.10×) applied to base input price.
 */
export function estimateCostUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const cacheWrite = cacheCreationInputTokens ?? 0;
  const cacheRead = cacheReadInputTokens ?? 0;

  const cacheWriteRate =
    pricing.cacheWrite5mUsdPer1M ?? pricing.inputUsdPer1M * ANTHROPIC_CACHE_WRITE_MULTIPLIER;
  const cacheReadRate =
    pricing.cacheReadUsdPer1M ?? pricing.inputUsdPer1M * ANTHROPIC_CACHE_READ_MULTIPLIER;

  const cost =
    (input / 1_000_000) * pricing.inputUsdPer1M +
    (output / 1_000_000) * pricing.outputUsdPer1M +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (cacheRead / 1_000_000) * cacheReadRate;
  return Number(cost.toFixed(6));
}

/**
 * Per-model total context-window size in tokens. Used by the chat token gauge
 * (issue #438) to compute "X / Y tokens · %Z" and to drive threshold colors.
 *
 * Sources: Anthropic & OpenAI & Google model docs (as of 2026-05-19).
 * Long-context GPT-4.1 family uses 1,047,576 (1M) which the API actually reports.
 * Gemini 1.5 / 2.0 series use 1M (or 2M for 1.5-pro extended).
 */
const CONTEXT_WINDOW_MAP: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,

  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.5-haiku': 200_000,
  'anthropic/claude-3-opus': 200_000,

  'gpt-4o-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'o3-mini': 200_000,

  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
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

  if (model.length >= 4) {
    for (const [key, window] of Object.entries(CONTEXT_WINDOW_MAP)) {
      if (model.startsWith(key) || key.startsWith(model)) return window;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}
