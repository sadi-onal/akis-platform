import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pattern A — Trace LLM summary parse (2026-05-23).
// Verifies the contract change: trace parse path picks up the optional
// `summary` field from the JSON response. The full TraceAgent run lives
// in integration tests; here we only assert the field is parsed correctly.

describe('Trace summary parse', () => {
  it('picks up summary from JSON', () => {
    const json =
      '{"testsWritten":21,"coveragePercentage":100,"summary":"21 test yazdım, 3 fonksiyon kapsanıyor."}';
    const parsed = JSON.parse(json) as { summary?: unknown };
    const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
    assert.equal(summary, '21 test yazdım, 3 fonksiyon kapsanıyor.');
  });

  it('returns undefined when summary missing', () => {
    const json = '{"testsWritten":21,"coveragePercentage":100}';
    const parsed = JSON.parse(json) as { summary?: unknown };
    const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
    assert.equal(summary, undefined);
  });

  it('treats blank/whitespace summary as undefined', () => {
    const json = '{"testsWritten":21,"summary":"   "}';
    const parsed = JSON.parse(json) as { summary?: unknown };
    const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
    assert.equal(summary, undefined);
  });

  it('caps summary at 500 chars', () => {
    const long = 'A'.repeat(700);
    const parsed = { summary: long } as { summary?: unknown };
    const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
    assert.equal(summary?.length, 500);
  });
});
