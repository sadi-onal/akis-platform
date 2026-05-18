// P5b: unit tests for AiCallsService — covers shape mapping + the DB-null
// short-circuit. The route-level test (pipeline-ai-calls-route.test.ts) stubs
// the whole service; this file exercises the service-internal mapping so a
// regression in `mapRowToAiCallEntry` (e.g. someone forgets the new P5a
// columns) is caught at the right layer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AiCallsService,
  mapRowToAiCallEntry,
} from '../../src/pipeline/core/ai-calls/AiCallsService.js';

type Row = Parameters<typeof mapRowToAiCallEntry>[0];

function fakeRow(overrides: Partial<Row> = {}): Row {
  const baseTs = new Date('2026-05-18T08:00:00Z');
  return {
    id: 'r-1',
    callIndex: 0,
    provider: 'mock',
    model: 'mock-model',
    purpose: 'plan',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 100,
    success: true,
    errorCode: null,
    timestamp: baseTs,
    systemPrompt: 'sys',
    userPrompt: 'usr',
    responseText: 'rsp',
    thinkingBlocks: null,
    toolCalls: null,
    ...overrides,
  };
}

describe('AiCallsService — mapRowToAiCallEntry', () => {
  it('serialises timestamp to ISO 8601 string', () => {
    const entry = mapRowToAiCallEntry(fakeRow());
    assert.equal(entry.timestamp, '2026-05-18T08:00:00.000Z');
  });

  it('passes through all P5a content columns', () => {
    const thinking = [{ type: 'thinking', text: 'hmm' }];
    const tools = [{ name: 'gh_read', input: {} }];
    const entry = mapRowToAiCallEntry(
      fakeRow({
        systemPrompt: 'You are AKIS',
        userPrompt: 'Build a TODO',
        responseText: '{"plan":"x"}',
        thinkingBlocks: thinking,
        toolCalls: tools,
      })
    );
    assert.equal(entry.systemPrompt, 'You are AKIS');
    assert.equal(entry.userPrompt, 'Build a TODO');
    assert.equal(entry.responseText, '{"plan":"x"}');
    assert.deepEqual(entry.thinkingBlocks, thinking);
    assert.deepEqual(entry.toolCalls, tools);
  });

  it('normalises non-array thinkingBlocks/toolCalls to null', () => {
    // jsonb columns can technically come back as objects/strings/etc. The
    // wire format restricts to `unknown[] | null`; guard against any
    // accidental shape drift.
    const entry = mapRowToAiCallEntry(
      fakeRow({
        // Casts narrow only the row signature, the runtime value still
        // exercises the guard.
        thinkingBlocks: { foo: 'bar' } as unknown as Row['thinkingBlocks'],
        toolCalls: 'oops' as unknown as Row['toolCalls'],
      })
    );
    assert.equal(entry.thinkingBlocks, null);
    assert.equal(entry.toolCalls, null);
  });

  it('preserves null content for legacy pre-P5a rows', () => {
    const entry = mapRowToAiCallEntry(
      fakeRow({
        systemPrompt: null,
        userPrompt: null,
        responseText: null,
        thinkingBlocks: null,
        toolCalls: null,
      })
    );
    assert.equal(entry.systemPrompt, null);
    assert.equal(entry.userPrompt, null);
    assert.equal(entry.responseText, null);
    assert.equal(entry.thinkingBlocks, null);
    assert.equal(entry.toolCalls, null);
  });
});

describe('AiCallsService — db short-circuit', () => {
  it('returns [] when db is explicitly disabled (db: null)', async () => {
    const svc = new AiCallsService({ db: null });
    const calls = await svc.getCalls('any-pipeline');
    assert.deepEqual(calls, []);
  });

  it('returns [] when pipelineId is empty', async () => {
    // db can stay default — service must short-circuit before touching it.
    const svc = new AiCallsService({ db: null });
    assert.deepEqual(await svc.getCalls(''), []);
  });
});
