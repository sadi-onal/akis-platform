/**
 * CostCalculator — role-aware AI cost accounting.
 *
 * Admin users (user.role === 'admin') see the REAL wholesale cost that
 * Anthropic / OpenAI / OpenRouter charges us. Regular users see a retail
 * price = wholesale × AI_COST_MARKUP (default 1.5, env-configurable).
 *
 * Issue #449.
 */

import { estimateCostUsd, getModelPricing } from '../ai/pricing.js';
import { getEnv } from '../../config/env.js';

export interface CostBreakdown {
  /** Wholesale cost (what the provider charges us). */
  wholesale: number;
  /** Retail price (what we charge the user) = wholesale * markup. */
  retail: number;
  /** Wholesale input-token cost. */
  input: number;
  /** Wholesale output-token cost. */
  output: number;
  /** Margin we collect = retail - wholesale. */
  margin: number;
  /** Markup factor applied (e.g. 1.5). */
  markup: number;
}

export interface CostCalculatorInput {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CostCalculatorResult {
  /**
   * The cost that should be displayed to this user.
   * Admin → wholesale. Regular user → retail.
   */
  displayCost: number;
  /** USD, always 'USD' for now. */
  currency: 'USD';
  /**
   * Full breakdown — always returned so callers can decide what to expose.
   * (API layer strips this for non-admins to avoid leaking wholesale data.)
   */
  breakdown: CostBreakdown;
  /** The model used (normalized if alias). */
  model: string;
  /**
   * True when model pricing is unknown. In that case we fall back to
   * any pre-computed cost stored upstream (see `withFallback`).
   */
  unknownModel: boolean;
}

export interface UserLike {
  role: 'admin' | 'member' | string;
}

/**
 * Returns the retail markup from env. Guarded so tests and callers can run
 * without a fully-loaded env (falls back to 1.5).
 */
export function getRetailMarkup(): number {
  try {
    return getEnv().AI_COST_MARKUP;
  } catch {
    return 1.5;
  }
}

/**
 * Round a USD amount to 6 decimal places (same precision used across the
 * pipeline metrics + usage aggregation).
 */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * Compute the breakdown for a single (model, tokens) pair.
 * If the model is unknown, wholesale/input/output all return 0 and
 * `unknownModel` is true — callers should fall back to any stored cost.
 */
export function calculateBreakdown(
  usage: CostCalculatorInput,
  markup: number = getRetailMarkup()
): { breakdown: CostBreakdown; unknownModel: boolean } {
  const pricing = getModelPricing(usage.model);
  if (!pricing) {
    return {
      breakdown: { wholesale: 0, retail: 0, input: 0, output: 0, margin: 0, markup },
      unknownModel: true,
    };
  }

  const input = round6((usage.inputTokens / 1_000_000) * pricing.inputUsdPer1M);
  const output = round6((usage.outputTokens / 1_000_000) * pricing.outputUsdPer1M);
  const wholesale = round6(input + output);
  const retail = round6(wholesale * markup);
  const margin = round6(retail - wholesale);

  return {
    breakdown: { wholesale, retail, input, output, margin, markup },
    unknownModel: false,
  };
}

/**
 * Main entrypoint — returns the cost a given user should see plus the full
 * breakdown. API callers decide whether to include `breakdown` in the
 * response based on `user.isAdmin`.
 */
export function calculateCost(
  usage: CostCalculatorInput,
  user: UserLike,
  markup: number = getRetailMarkup()
): CostCalculatorResult {
  const { breakdown, unknownModel } = calculateBreakdown(usage, markup);
  const isAdmin = user.role === 'admin';

  return {
    displayCost: isAdmin ? breakdown.wholesale : breakdown.retail,
    currency: 'USD',
    breakdown,
    model: usage.model,
    unknownModel,
  };
}

/**
 * Derive the user-facing cost from a pre-computed *wholesale* cost total
 * (aggregated over many pipelines/models). Used by /api/usage which sums
 * per-pipeline `metrics.estimatedCost` from the DB.
 *
 * Returns a breakdown with input/output set to 0 (we don't track them
 * separately at the aggregate level — each pipeline row stores only the
 * total). This is still useful: admins see wholesale + margin, users see
 * retail.
 */
export function aggregateCost(
  wholesale: number,
  user: UserLike,
  markup: number = getRetailMarkup()
): { displayCost: number; currency: 'USD'; breakdown: CostBreakdown } {
  const safeWholesale = round6(wholesale || 0);
  const retail = round6(safeWholesale * markup);
  const margin = round6(retail - safeWholesale);
  const isAdmin = user.role === 'admin';

  return {
    displayCost: isAdmin ? safeWholesale : retail,
    currency: 'USD',
    breakdown: {
      wholesale: safeWholesale,
      retail,
      input: 0,
      output: 0,
      margin,
      markup,
    },
  };
}

/**
 * Thin wrapper around `estimateCostUsd` that adds a retail price. Handy in
 * places that already call pricing directly and just want a quick number.
 */
export function estimateRetailCostUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  markup: number = getRetailMarkup()
): number | null {
  const wholesale = estimateCostUsd(model, inputTokens, outputTokens);
  if (wholesale === null) return null;
  return round6(wholesale * markup);
}
