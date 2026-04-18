/**
 * Humanize a token count for compact UI:
 *   1_234_567 → "1.23M"   (1M+ context windows — GPT-4.1)
 *   12_345    → "12.3k"
 *   456       → "456"
 *
 * Used by the chat TokenGauge pill (issue #438). Negative / NaN inputs are
 * clamped to "0" so the gauge never renders garbage while a pipeline is
 * still spinning up and metrics haven't arrived yet.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
