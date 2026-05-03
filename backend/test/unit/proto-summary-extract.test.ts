import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractProtoSummary } from '../../src/pipeline/agents/proto/ProtoAgent.js';

describe('extractProtoSummary', () => {
  it('returns undefined for empty / whitespace input', () => {
    assert.equal(extractProtoSummary(''), undefined);
    assert.equal(extractProtoSummary('   \n\n  '), undefined);
    assert.equal(extractProtoSummary(undefined), undefined);
    assert.equal(extractProtoSummary(null), undefined);
  });

  it('returns plain Turkish text untouched (typical happy path)', () => {
    const input = 'React + Vite ile basit bir todo uygulaması iskeleti oluşturuldu.';
    assert.equal(extractProtoSummary(input), input);
  });

  it('strips ```...``` code fences', () => {
    const input = '```\nReact + Vite ile todo uygulaması.\n```';
    assert.equal(extractProtoSummary(input), 'React + Vite ile todo uygulaması.');
  });

  it('strips ```lang fences with language tag', () => {
    const input = '```text\nProto özeti.\n```';
    assert.equal(extractProtoSummary(input), 'Proto özeti.');
  });

  it('parses JSON when present and pulls .summary field', () => {
    const input = '{"summary": "JSON içinden alınan özet.", "files": []}';
    assert.equal(extractProtoSummary(input), 'JSON içinden alınan özet.');
  });

  it('returns undefined for JSON without summary field', () => {
    const input = '{"files": [], "metadata": {"filesCreated": 5}}';
    assert.equal(extractProtoSummary(input), undefined);
  });

  it('clamps very long summaries at 500 chars', () => {
    const long = 'a'.repeat(800);
    const out = extractProtoSummary(long);
    assert.equal(out?.length, 500);
  });

  it('clamps the JSON-extracted summary as well', () => {
    const long = 'b'.repeat(800);
    const input = JSON.stringify({ summary: long });
    const out = extractProtoSummary(input);
    assert.equal(out?.length, 500);
  });
});
