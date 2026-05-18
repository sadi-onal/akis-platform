/**
 * P5a: Helpers for capping AI prompt/response content stored in
 * `job_ai_calls`. Production DB must not balloon when a Proto run sends a
 * 200-page system prompt; we keep the head of the content + a truncated
 * marker so downstream viewers (P5b) can still show a useful preview.
 */

const TRUNCATED_MARKER = '... [truncated]';

/**
 * Truncate a string so its UTF-8 byte length never exceeds `maxBytes`.
 *
 * - Returns `undefined` when input is `undefined`.
 * - Returns the original string when it already fits.
 * - When over the limit, returns the head + `... [truncated]` suffix. The
 *   suffix itself is included in the budget so the returned string is
 *   guaranteed `<= maxBytes`.
 * - Uses `Buffer.subarray` + `toString('utf8')` to avoid splitting a
 *   multi-byte code point at the cut boundary (Node decodes the trailing
 *   incomplete bytes as the replacement char rather than corrupt UTF-8).
 */
export function truncateForLog(
  content: string | undefined,
  maxBytes: number,
): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (maxBytes <= 0) return TRUNCATED_MARKER;

  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= maxBytes) return content;

  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  // If even the marker doesn't fit, just return the marker (clipped).
  if (maxBytes <= markerBytes) {
    return TRUNCATED_MARKER.slice(0, Math.max(0, maxBytes));
  }

  const headBytes = maxBytes - markerBytes;
  return buf.subarray(0, headBytes).toString('utf8') + TRUNCATED_MARKER;
}

/**
 * Truncate a JSON-serialisable structure (thinking blocks, tool calls) by
 * stringifying and capping the resulting JSON. Returns the original object
 * when it fits, otherwise a sentinel `{ _truncated: true, _preview: <head> }`
 * shape so consumers can detect truncation without parsing a malformed JSON
 * string.
 */
export function truncateStructuredForLog(
  value: unknown,
  maxBytes: number,
): unknown {
  if (value === undefined || value === null) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return value;
  const head = truncateForLog(json, maxBytes) ?? '';
  return { _truncated: true, _originalBytes: Buffer.byteLength(json, 'utf8'), _preview: head };
}
