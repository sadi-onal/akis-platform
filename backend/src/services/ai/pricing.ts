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
 * Estimates the USD cost for a given model and token counts.
 * Returns cost with 6 decimal places, or null if model pricing unknown.
 */
export function estimateCostUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;

  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const cost =
    (input / 1_000_000) * pricing.inputUsdPer1M +
    (output / 1_000_000) * pricing.outputUsdPer1M;
  return Number(cost.toFixed(6));
}
