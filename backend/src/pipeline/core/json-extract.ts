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

  // Strategy 2b (PR-H 2026-05-19, hardened PR-V 2026-05-20): truncated fenced
  // JSON — model started with ```json fence but ran out of `max_tokens` before
  // emitting the closing fence. Strip the leading fence (and the trailing
  // partial fence if present) so the downstream brace/repair logic has a clean
  // candidate.
  //
  // PR-V (2026-05-20) — Bug 1 fix: the previous implementation used the naive
  // `lastIndexOf('}')` to find the slice point, which lands inside an unclosed
  // string value when the model truncates mid-code (e.g. `await page.click({
  // page }`). That `}` belongs to a JavaScript object literal *inside the
  // string value*, NOT to the JSON envelope. Slicing there breaks repair.
  // Fix: structurally walk the stripped text, ignoring `}`/`]` that appear
  // inside JSON string literals. If we find a structurally-closed end (depth
  // returns to zero), slice there. Otherwise return the full stripped text so
  // `repairTruncatedJson` can close it cleanly.
  const leadingFence = trimmed.match(/^```(?:json)?\s*\n?/);
  if (leadingFence) {
    let stripped = trimmed.slice(leadingFence[0].length);
    // Drop any trailing "```" or partial fence remnant ("``" / "`") if the model
    // managed to start the closer before truncation.
    stripped = stripped
      .replace(/```\s*$/, '')
      .replace(/``\s*$/, '')
      .replace(/`\s*$/, '');
    if (stripped.startsWith('{')) {
      const structuralEnd = findStructuralEnd(stripped);
      if (structuralEnd !== -1) return stripped.slice(0, structuralEnd + 1);
      // Truncation detected (still inside string or depth > 0) — pass the full
      // stripped text downstream so `repairTruncatedJson` can fix it.
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
 * PR-V (2026-05-20) — string-aware structural walker.
 *
 * Walks `text` char-by-char tracking whether we are currently inside a JSON
 * string literal (with proper `\"` escape handling). Returns:
 *
 *  - `endIdx`  — index of the last `}` that brings the structural depth back
 *                to zero (i.e. a complete top-level object). `-1` if no such
 *                point exists (truncation).
 *  - `inStr`   — true at EOF if still inside an unclosed string literal.
 *  - `opens`   — sequence of unclosed `{` / `[` openers in order (innermost
 *                last). Use to know how many `}` / `]` to append to close.
 *
 * This is the foundation for both `extractJsonSafe` strategy 2b (where we
 * must NOT slice at a `}` inside an unclosed string) and `repairTruncatedJson`
 * (where we must close the string FIRST, then close brackets in order).
 */
function findStructuralEnd(text: string): number {
  let depth = 0;
  let inStr = false;
  let lastValidEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && c === '}') lastValidEnd = i;
    }
  }
  // If we are still in a string OR depth never returned to 0, no clean end.
  return inStr || depth !== 0 ? -1 : lastValidEnd;
}

/**
 * Walk a JSON candidate and report the open structural state.
 * Differs from `findStructuralEnd` in that it always returns the full state
 * (so the repair logic can close everything appropriately).
 */
function scanJsonState(text: string): { inStr: boolean; opens: string[] } {
  const opens: string[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') opens.push(c);
    else if (c === '}' || c === ']') opens.pop();
  }
  return { inStr, opens };
}

/**
 * Attempt to repair truncated JSON (e.g. from a max_tokens cutoff)
 * by closing open strings, arrays, and objects.
 *
 * Returns the repaired string, or `null` if repair is not possible.
 *
 * PR-V (2026-05-20) rewrite: previously this function used `(?<!\\)"` regex
 * to detect odd quote counts and a separate forward pass to close brackets.
 * That heuristic failed when the truncation point landed mid-string with
 * literal newlines inside the open string (the structural walk treats raw
 * newlines as ordinary chars, but `JSON.parse` rejects them). The new
 * implementation:
 *
 *   1. Structurally walks the candidate (with proper escape handling).
 *   2. If still inside a string at EOF, sanitizes control chars inside that
 *      unclosed string AND closes it with `"`.
 *   3. Strips any trailing `,` or unfinished key fragment before appending
 *      the structural closers in stack order.
 */
export function repairTruncatedJson(text: string): string | null {
  let json = extractJsonSafe(text);
  if (!json.startsWith('{')) return null;

  // Already valid — fast path
  try {
    JSON.parse(json);
    return json;
  } catch {
    /* continue */
  }

  const originalLen = json.length;
  const state = scanJsonState(json);

  // Step 1: if we ended inside a string, sanitize raw control chars inside
  // that unclosed tail (they would fail `JSON.parse` otherwise) and close
  // the string with `"`. We walk again to find the *last* unescaped `"` so
  // we know the boundary of the open string tail.
  if (state.inStr) {
    let lastOpenQuote = -1;
    let inStr = false;
    for (let i = 0; i < json.length; i++) {
      const c = json[i];
      if (c === '"' && (i === 0 || json[i - 1] !== '\\')) {
        inStr = !inStr;
        if (inStr) lastOpenQuote = i;
      }
    }
    if (lastOpenQuote >= 0) {
      const head = json.slice(0, lastOpenQuote + 1);
      const tail = json.slice(lastOpenQuote + 1);
      // Sanitize control chars + drop trailing backslash (would create an
      // invalid escape sequence at the close `"`).
      const cleanedTail = sanitizeJsonControlChars(`"${tail}"`).slice(1, -1);
      const safeTail = cleanedTail.replace(/\\+$/, '');
      json = head + safeTail + '"';
    } else {
      json += '"';
    }
  }

  // Step 2: drop a trailing `,` or `:` or a half-written key like `"foo":`
  // with no value — common when truncation hits between a key and its value.
  json = json.replace(/,\s*$/, '');
  // Trailing `"key":` with no value → drop the key fragment too.
  json = json.replace(/,?\s*"[^"\\]*"\s*:\s*$/, '');
  // Trailing standalone `:` (very rare) — drop.
  json = json.replace(/:\s*$/, '');

  // Step 3: walk the (now string-closed) text to find the still-open
  // brackets, then close them in reverse stack order.
  const { opens } = scanJsonState(json);
  while (opens.length > 0) {
    const open = opens.pop();
    json += open === '{' ? '}' : ']';
  }

  try {
    JSON.parse(json);
    logger.warn(
      `[json-extract] Repaired truncated JSON (added ${json.length - originalLen} closing chars)`
    );
    return json;
  } catch {
    // Last-ditch: a trailing field may be malformed (e.g. unfinished
    // number/literal). Try walking back to the last comma at depth 1 and
    // truncating, then re-closing.
    const fallback = trimToLastCompleteField(json);
    if (fallback) {
      try {
        JSON.parse(fallback);
        logger.warn(
          `[json-extract] Repaired truncated JSON via field-trim (added ${fallback.length - originalLen} chars)`
        );
        return fallback;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/**
 * Walk back from the end to the last comma that sits at JSON depth 1 (i.e.
 * between top-level object members) and truncate there, then re-close all
 * open brackets. Used as a last-resort repair when the trailing field is
 * malformed beyond what string-closure + bracket-balancing can fix.
 */
function trimToLastCompleteField(json: string): string | null {
  let depth = 0;
  let inStr = false;
  let lastCommaAtDepth1 = -1;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"' && (i === 0 || json[i - 1] !== '\\')) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) lastCommaAtDepth1 = i;
  }
  if (lastCommaAtDepth1 === -1) return null;
  let trimmed = json.slice(0, lastCommaAtDepth1);
  const { opens } = scanJsonState(trimmed);
  while (opens.length > 0) {
    const open = opens.pop();
    trimmed += open === '{' ? '}' : ']';
  }
  return trimmed;
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
  } catch {
    /* continue */
  }

  // Attempt 2: sanitize control chars then parse
  const sanitized = sanitizeJsonControlChars(extracted);
  try {
    return JSON.parse(sanitized) as T;
  } catch {
    /* continue */
  }

  // Attempt 3: repair truncated JSON
  const repaired = repairTruncatedJson(text);
  if (repaired) {
    try {
      return JSON.parse(repaired) as T;
    } catch {
      /* continue */
    }
    // Attempt 3b (PR-H 2026-05-19): sanitize control chars on the repaired
    // string. When the model emits literal newlines inside a string value
    // before truncation, `repairTruncatedJson` only closes brackets — the
    // control chars still break `JSON.parse`. Running the sanitizer afterwards
    // covers both failure modes in one pass.
    try {
      return JSON.parse(sanitizeJsonControlChars(repaired)) as T;
    } catch {
      /* continue */
    }
  }

  // All strategies exhausted
  throw new SyntaxError(
    `Failed to parse AI JSON response (length=${text.length}). ` +
      `First 200 chars: ${text.slice(0, 200)}`
  );
}
