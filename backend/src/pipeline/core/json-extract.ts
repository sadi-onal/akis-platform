/**
 * Shared JSON extraction utilities for pipeline agents.
 *
 * AI models often wrap JSON in markdown fences (```json ... ```) or produce
 * truncated output when hitting max_tokens.  These helpers robustly extract
 * and repair the JSON regardless of how the model decorated it.
 *
 * Ported from ProtoAgent's battle-tested implementation and hardened with
 * additional edge-case handling (nested backticks, control characters, etc.).
 */

import { logger } from '../../lib/logger.js';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Extract a JSON object from an AI response that may be wrapped in
 * markdown code fences, contain control characters, or be truncated.
 *
 * Strategy order:
 *  1. Pure JSON — response already starts with `{`
 *  2. Fenced code block — `` ```json ... ``` ``
 *  3. Brace extraction — first `{` to last `}`
 *  4. Last resort — return trimmed text
 */
export function extractJsonSafe(text: string): string {
  const trimmed = text.trim();

  // Strategy 1: pure JSON (avoids regex false-matches on backticks inside JSON strings)
  if (trimmed.startsWith('{')) {
    const braceEnd = trimmed.lastIndexOf('}');
    if (braceEnd > 0) return trimmed.slice(0, braceEnd + 1);
    return trimmed;
  }

  // Strategy 2: fenced code block (full block — opening + closing fence present)
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenced) return fenced[1].trim();

  // Strategy 2b (PR-H 2026-05-19): truncated fenced JSON — model started with
  // ```json fence but ran out of `max_tokens` before emitting the closing fence.
  // Strip the leading fence (and the trailing partial fence if present) so the
  // downstream brace/repair logic has a clean candidate.
  // Bug observed with Trace responses where output_tokens hit the 32 768 cap
  // mid-test-file content (responseLen 33-45K, no closing fence).
  const leadingFence = trimmed.match(/^```(?:json)?\s*\n?/);
  if (leadingFence) {
    let stripped = trimmed.slice(leadingFence[0].length);
    // Drop any trailing "```" or partial fence remnant ("``" / "`") if the model
    // managed to start the closer before truncation.
    stripped = stripped.replace(/```\s*$/, '').replace(/``\s*$/, '').replace(/`\s*$/, '');
    if (stripped.startsWith('{')) {
      const braceEnd = stripped.lastIndexOf('}');
      // When `}` is missing (deep truncation), return as-is so
      // `repairTruncatedJson` can close the structure.
      if (braceEnd > 0) return stripped.slice(0, braceEnd + 1);
      return stripped;
    }
  }

  // Strategy 3: brace extraction
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return trimmed;
}

/**
 * Escape raw control characters that appear inside JSON string values.
 * AI models sometimes emit literal newlines / tabs instead of `\n` / `\t`.
 */
export function sanitizeJsonControlChars(json: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    const code = c.charCodeAt(0);

    if (c === '"' && (i === 0 || json[i - 1] !== '\\')) {
      inString = !inString;
      result += c;
    } else if (inString && code < 32) {
      if (code === 10) result += '\\n';
      else if (code === 13) result += '\\r';
      else if (code === 9) result += '\\t';
      else result += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      result += c;
    }
  }
  return result;
}

/**
 * Attempt to repair truncated JSON (e.g. from a max_tokens cutoff)
 * by closing open strings, arrays, and objects.
 *
 * Returns the repaired string, or `null` if repair is not possible.
 */
export function repairTruncatedJson(text: string): string | null {
  let json = extractJsonSafe(text);
  if (!json.startsWith('{')) return null;

  // Already valid — fast path
  try { JSON.parse(json); return json; } catch { /* continue */ }

  // Close any open string literal
  const quoteCount = (json.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    json += '"';
  }

  // Remove trailing comma before closing brackets
  json = json.replace(/,\s*$/, '');

  // Walk through and close open brackets / braces
  const opens: string[] = [];
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"' && (i === 0 || json[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') opens.push(c);
    if (c === '}' || c === ']') opens.pop();
  }

  while (opens.length > 0) {
    const open = opens.pop();
    json += open === '{' ? '}' : ']';
  }

  try {
    JSON.parse(json);
    logger.warn(
      `[json-extract] Repaired truncated JSON (added ${json.length - extractJsonSafe(text).length} closing chars)`,
    );
    return json;
  } catch {
    return null;
  }
}

/**
 * High-level helper: extract → parse → sanitize → repair.
 * Returns the parsed object or throws with a descriptive message.
 */
export function parseAIJson<T = unknown>(text: string): T {
  const extracted = extractJsonSafe(text);

  // Attempt 1: direct parse
  try {
    return JSON.parse(extracted) as T;
  } catch { /* continue */ }

  // Attempt 2: sanitize control chars then parse
  const sanitized = sanitizeJsonControlChars(extracted);
  try {
    return JSON.parse(sanitized) as T;
  } catch { /* continue */ }

  // Attempt 3: repair truncated JSON
  const repaired = repairTruncatedJson(text);
  if (repaired) {
    try {
      return JSON.parse(repaired) as T;
    } catch { /* continue */ }
    // Attempt 3b (PR-H 2026-05-19): sanitize control chars on the repaired
    // string. When the model emits literal newlines inside a string value
    // before truncation, `repairTruncatedJson` only closes brackets — the
    // control chars still break `JSON.parse`. Running the sanitizer afterwards
    // covers both failure modes in one pass.
    try {
      return JSON.parse(sanitizeJsonControlChars(repaired)) as T;
    } catch { /* continue */ }
  }

  // All strategies exhausted
  throw new SyntaxError(
    `Failed to parse AI JSON response (length=${text.length}). ` +
    `First 200 chars: ${text.slice(0, 200)}`,
  );
}
