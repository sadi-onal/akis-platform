/**
 * Shorten full model IDs for compact UI pills (issue #437):
 *   "claude-haiku-4-5-20251001"      → "claude-haiku-4-5"
 *   "claude-sonnet-4-6"              → "claude-sonnet-4-6"
 *   "gpt-4o-mini"                    → "gpt-4o-mini"
 *
 * Used by the ChatHeader's ModelPicker pill so the dropdown fits next to
 * the token gauge without wrapping. PR-A removed the `org/model` slash
 * branch along with OpenRouter — no provider serves that ID format anymore.
 */
export function shortModelLabel(modelId: string): string {
  return modelId.replace(/-\d{8}$/, '');
}
