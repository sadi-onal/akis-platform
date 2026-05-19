import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJsonSafe,
  sanitizeJsonControlChars,
  repairTruncatedJson,
  parseAIJson,
} from '../../src/pipeline/core/json-extract.js';

// ─── extractJsonSafe ──────────────────────────────

describe('extractJsonSafe', () => {
  it('returns pure JSON when input starts with {', () => {
    const json = '{"key": "value"}';
    assert.equal(extractJsonSafe(json), json);
  });

  it('trims whitespace before detecting pure JSON', () => {
    const json = '  \n  {"key": "value"}  \n  ';
    assert.equal(extractJsonSafe(json), '{"key": "value"}');
  });

  it('extracts from ```json fenced code block', () => {
    const input = 'Here is the result:\n```json\n{"ok": true}\n```\nDone.';
    assert.equal(extractJsonSafe(input), '{"ok": true}');
  });

  it('extracts from ``` fenced code block without json label', () => {
    const input = '```\n{"ok": true}\n```';
    assert.equal(extractJsonSafe(input), '{"ok": true}');
  });

  it('falls back to brace extraction when no fences', () => {
    const input = 'The response is: {"ok": true} and thats it.';
    assert.equal(extractJsonSafe(input), '{"ok": true}');
  });

  it('handles nested braces correctly via outermost extraction', () => {
    const input = '{"outer": {"inner": true}}';
    const result = extractJsonSafe(input);
    assert.deepEqual(JSON.parse(result), { outer: { inner: true } });
  });

  it('returns trimmed text if no JSON found', () => {
    const input = '  no json here  ';
    assert.equal(extractJsonSafe(input), 'no json here');
  });

  it('handles pure JSON that starts with { but has no closing }', () => {
    const input = '{"broken';
    assert.equal(extractJsonSafe(input), '{"broken');
  });

  it('handles JSON with surrounding markdown text', () => {
    const input = 'I generated the following:\n\n{"files": [{"path": "a.ts"}]}\n\nLet me know if you need changes.';
    assert.equal(extractJsonSafe(input), '{"files": [{"path": "a.ts"}]}');
  });

  it('handles multiline JSON inside fences', () => {
    const input = '```json\n{\n  "title": "Test",\n  "items": [1, 2, 3]\n}\n```';
    const result = JSON.parse(extractJsonSafe(input));
    assert.equal(result.title, 'Test');
    assert.deepEqual(result.items, [1, 2, 3]);
  });
});

// ─── sanitizeJsonControlChars ─────────────────────

describe('sanitizeJsonControlChars', () => {
  it('escapes literal newlines inside JSON strings', () => {
    const json = '{"text": "line1\nline2"}';
    const result = sanitizeJsonControlChars(json);
    assert.equal(result, '{"text": "line1\\nline2"}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('escapes literal tabs inside JSON strings', () => {
    const json = '{"text": "col1\tcol2"}';
    const result = sanitizeJsonControlChars(json);
    assert.equal(result, '{"text": "col1\\tcol2"}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('escapes carriage returns inside JSON strings', () => {
    const json = '{"text": "line1\r\nline2"}';
    const result = sanitizeJsonControlChars(json);
    assert.equal(result, '{"text": "line1\\r\\nline2"}');
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('does not modify control chars outside strings', () => {
    const json = '{\n  "key": "value"\n}';
    const result = sanitizeJsonControlChars(json);
    // The newlines outside strings stay as-is
    assert.ok(result.includes('\n'));
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('handles escaped quotes correctly', () => {
    const json = '{"text": "say \\"hello\\""}';
    const result = sanitizeJsonControlChars(json);
    assert.doesNotThrow(() => JSON.parse(result));
  });

  it('passes through valid JSON unchanged', () => {
    const json = '{"key": "value", "num": 42}';
    assert.equal(sanitizeJsonControlChars(json), json);
  });
});

// ─── repairTruncatedJson ──────────────────────────

describe('repairTruncatedJson', () => {
  it('returns valid JSON as-is', () => {
    const json = '{"ok": true}';
    assert.equal(repairTruncatedJson(json), json);
  });

  it('closes unclosed object brace', () => {
    const json = '{"ok": true';
    const result = repairTruncatedJson(json);
    assert.ok(result);
    assert.deepEqual(JSON.parse(result!), { ok: true });
  });

  it('closes unclosed array bracket', () => {
    const json = '{"items": [1, 2, 3';
    const result = repairTruncatedJson(json);
    assert.ok(result);
    const parsed = JSON.parse(result!);
    assert.deepEqual(parsed.items, [1, 2, 3]);
  });

  it('closes nested unclosed structures', () => {
    const json = '{"outer": {"inner": [1, 2';
    const result = repairTruncatedJson(json);
    assert.ok(result);
    const parsed = JSON.parse(result!);
    assert.deepEqual(parsed.outer.inner, [1, 2]);
  });

  it('removes trailing comma before closing', () => {
    const json = '{"items": [1, 2,';
    const result = repairTruncatedJson(json);
    assert.ok(result);
    const parsed = JSON.parse(result!);
    assert.deepEqual(parsed.items, [1, 2]);
  });

  it('returns null for non-JSON input', () => {
    assert.equal(repairTruncatedJson('not json at all'), null);
  });

  it('handles truncated string values', () => {
    const json = '{"name": "truncated val';
    const result = repairTruncatedJson(json);
    assert.ok(result);
    assert.doesNotThrow(() => JSON.parse(result!));
  });

  it('repairs JSON inside fenced code blocks', () => {
    // When fenced block has complete JSON, repair returns it as-is
    const input = '```json\n{"ok": true}\n```';
    const result = repairTruncatedJson(input);
    assert.ok(result);
    assert.deepEqual(JSON.parse(result!), { ok: true });
  });

  it('repairs truncated JSON inside fenced code blocks', () => {
    // When fenced block has truncated JSON (missing closing brace),
    // extractJsonSafe falls through to brace extraction
    const input = '{"items": [1, 2, 3], "ok": true';
    const result = repairTruncatedJson(input);
    assert.ok(result);
    assert.deepEqual(JSON.parse(result!), { items: [1, 2, 3], ok: true });
  });
});

// ─── parseAIJson ──────────────────────────────────

describe('parseAIJson', () => {
  it('parses clean JSON', () => {
    const result = parseAIJson('{"ok": true}');
    assert.deepEqual(result, { ok: true });
  });

  it('parses JSON wrapped in ```json fences', () => {
    const input = '```json\n{"files": ["a.ts", "b.ts"]}\n```';
    const result = parseAIJson<{ files: string[] }>(input);
    assert.deepEqual(result.files, ['a.ts', 'b.ts']);
  });

  it('parses JSON with surrounding text', () => {
    const input = 'Here is your result:\n\n{"score": 0.95}\n\nHope this helps!';
    const result = parseAIJson<{ score: number }>(input);
    assert.equal(result.score, 0.95);
  });

  it('parses JSON with control characters in strings', () => {
    const rawJson = '{"content": "line1\nline2\ttab"}';
    const result = parseAIJson<{ content: string }>(rawJson);
    assert.equal(result.content, 'line1\nline2\ttab');
  });

  it('parses truncated JSON by repairing', () => {
    const input = '{"testFiles": [{"path": "test.ts"}';
    const result = parseAIJson<{ testFiles: unknown[] }>(input);
    assert.equal(result.testFiles.length, 1);
  });

  it('throws SyntaxError for completely invalid input', () => {
    assert.throws(
      () => parseAIJson('this is not json at all'),
      (err: unknown) => err instanceof SyntaxError,
    );
  });

  it('throws with descriptive message including input preview', () => {
    try {
      parseAIJson('garbage input with no json');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof SyntaxError);
      assert.ok(err.message.includes('Failed to parse AI JSON'));
      assert.ok(err.message.includes('garbage input'));
    }
  });

  it('handles the exact ```json wrapper issue from Trace agent', () => {
    const aiResponse = '```json\n{"testFiles": [{"filePath": "tests/e2e/app.spec.ts", "content": "test code", "testCount": 3}], "coverageMatrix": {"ac-1": ["tests/e2e/app.spec.ts"]}, "testSummary": {"totalTests": 3, "frameworks": ["playwright"]}}\n```';
    const result = parseAIJson<{ testFiles: unknown[]; testSummary: { totalTests: number } }>(aiResponse);
    assert.equal(result.testFiles.length, 1);
    assert.equal(result.testSummary.totalTests, 3);
  });

  it('handles ```json without closing ``` (truncated fence)', () => {
    const input = '```json\n{"ok": true, "items": [1, 2, 3]}';
    const result = parseAIJson<{ ok: boolean; items: number[] }>(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.items, [1, 2, 3]);
  });

  // PR-H regression (2026-05-19): Trace failed three times in production
  // because the AI response was wrapped in ```json fences, hit the 32 768
  // max_tokens cap mid-`content` string of the last testFile, and never
  // emitted the closing brace or fence. extractJsonSafe's strategy 3
  // brace-extraction picked up a stray `}` inside the truncated `content`
  // string, producing invalid JSON. Strategy 2b now strips the leading fence
  // and lets repairTruncatedJson close the structure cleanly.
  it('parses ```json fence truncated mid-string with multi-line content', () => {
    // Simulates a Trace response truncated mid testFile content where the
    // last open string contains literal newlines from the source code.
    const truncated =
      '```json\n' +
      '{\n' +
      '  "testFiles": [\n' +
      '    {\n' +
      '      "filePath": "tests/e2e/app.spec.ts",\n' +
      '      "content": "import { test, expect } from \'@playwright/test\';\\n\\ntest(\'works\', async ({ page }) => {\\n  await page.goto(\'/\');\\n  await expect(page.getByRole(\'heading\')).toBeVisible();\\n});",\n' +
      '      "testCount": 1\n' +
      '    },\n' +
      '    {\n' +
      '      "filePath": "tests/e2e/crud.spec.ts",\n' +
      '      "content": "import { test, expect } from \'@playwright/test\';\\n\\ntest(\'creates\', async ({ page';
    const result = parseAIJson<{ testFiles: Array<{ filePath: string; testCount?: number }> }>(
      truncated,
    );
    assert.ok(Array.isArray(result.testFiles), 'testFiles should be an array');
    assert.ok(result.testFiles.length >= 1, 'at least one testFile recovered');
    assert.equal(result.testFiles[0].filePath, 'tests/e2e/app.spec.ts');
  });

  it('parses ```json fence truncated with literal newlines (no escape)', () => {
    // Some models emit raw newlines inside string values when streaming —
    // sanitizeJsonControlChars handles them, but only when the repair path
    // also runs them through the sanitizer. PR-H Attempt 3b regression.
    const truncated =
      '```json\n' +
      '{"testFiles": [{"filePath": "a.ts", "content": "line1\nline2\nline3"}], "ok": true}';
    const result = parseAIJson<{ testFiles: Array<{ filePath: string }>; ok: boolean }>(truncated);
    assert.equal(result.ok, true);
    assert.equal(result.testFiles[0].filePath, 'a.ts');
  });

  it('handles deeply nested JSON', () => {
    const input = '{"a": {"b": {"c": {"d": [1, 2, 3]}}}}';
    const result = parseAIJson<{ a: { b: { c: { d: number[] } } } }>(input);
    assert.deepEqual(result.a.b.c.d, [1, 2, 3]);
  });

  it('preserves generic type parameter', () => {
    interface MyType { name: string; count: number }
    const result = parseAIJson<MyType>('{"name": "test", "count": 42}');
    assert.equal(result.name, 'test');
    assert.equal(result.count, 42);
  });
});
