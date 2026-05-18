/**
 * P5a: truncation helpers for AI prompt/response persistence.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  truncateForLog,
  truncateStructuredForLog,
} from '../../src/services/ai/truncatePromptContent.js';

describe('truncateForLog', () => {
  test('returns undefined for undefined input', () => {
    assert.strictEqual(truncateForLog(undefined, 100), undefined);
  });

  test('returns content unchanged when under limit', () => {
    assert.strictEqual(truncateForLog('hello world', 100), 'hello world');
  });

  test('returns content unchanged when exactly at limit', () => {
    const s = 'abcdef'; // 6 bytes
    assert.strictEqual(truncateForLog(s, 6), s);
  });

  test('truncates with marker when over limit', () => {
    const s = 'a'.repeat(1000);
    const result = truncateForLog(s, 100);
    assert.ok(result !== undefined);
    assert.ok(result.endsWith('... [truncated]'));
    assert.ok(Buffer.byteLength(result, 'utf8') <= 100);
  });

  test('respects byte budget including marker', () => {
    const s = 'x'.repeat(5000);
    const limit = 200;
    const result = truncateForLog(s, limit);
    assert.ok(result !== undefined);
    assert.ok(Buffer.byteLength(result, 'utf8') <= limit);
    assert.ok(result.endsWith('... [truncated]'));
  });

  test('does not corrupt multi-byte utf8 at boundary', () => {
    // Each emoji is 4 utf-8 bytes; pick a budget where naive substring would
    // split mid-codepoint.
    const s = '🚀'.repeat(50); // 200 bytes
    const result = truncateForLog(s, 50);
    assert.ok(result !== undefined);
    // Decoding must succeed (no Buffer round-trip throws), and result must
    // not exceed budget.
    assert.ok(Buffer.byteLength(result, 'utf8') <= 50);
    assert.ok(result.endsWith('... [truncated]'));
  });

  test('handles tiny budget smaller than marker by clipping marker', () => {
    const s = 'abcdefghij';
    const result = truncateForLog(s, 5);
    assert.ok(result !== undefined);
    assert.ok(Buffer.byteLength(result, 'utf8') <= 5);
  });

  test('returns marker placeholder when budget is zero', () => {
    const result = truncateForLog('anything', 0);
    assert.strictEqual(result, '... [truncated]');
  });
});

describe('truncateStructuredForLog', () => {
  test('returns undefined for undefined', () => {
    assert.strictEqual(truncateStructuredForLog(undefined, 100), undefined);
  });

  test('returns object unchanged when fitting', () => {
    const obj = { a: 1, b: 'hello' };
    assert.strictEqual(truncateStructuredForLog(obj, 1000), obj);
  });

  test('returns sentinel with preview when over limit', () => {
    const obj = { huge: 'x'.repeat(5000) };
    const result = truncateStructuredForLog(obj, 200) as {
      _truncated: boolean;
      _originalBytes: number;
      _preview: string;
    };
    assert.strictEqual(result._truncated, true);
    assert.ok(result._originalBytes > 200);
    assert.ok(typeof result._preview === 'string');
    assert.ok(result._preview.endsWith('... [truncated]'));
  });
});
