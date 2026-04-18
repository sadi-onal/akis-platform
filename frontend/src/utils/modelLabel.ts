/**
 * Shorten full model IDs for compact UI pills (issue #437):
 *   "claude-haiku-4-5-20251001"      → "claude-haiku-4-5"
 *   "claude-sonnet-4-20250514"       → "claude-sonnet-4"
 *   "anthropic/claude-3.5-sonnet"    → "claude-3.5-sonnet"
 *   "gpt-4o-mini"                    → "gpt-4o-mini"
 *
 * Used by the ChatHeader's ModelPicker pill so the dropdown fits next to
 * the token gauge without wrapping.
 */
export function shortModelLabel(modelId: string): string {
  if (modelId.includes('/')) {
    const tail = modelId.split('/').pop();
    return tail ?? modelId;
  }
  return modelId.replace(/-\d{8}$/, '');
}
