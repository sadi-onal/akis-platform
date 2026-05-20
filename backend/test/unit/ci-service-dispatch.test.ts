// T3: regression — `triggerWorkflowDispatch` must target `akis-e2e.yml`,
// not the legacy `akis-tests.yml` name. The workflow YAML pushed by Proto
// (pipeline/templates/akisE2eWorkflow.ts) is named `akis-e2e.yml`, so any
// other workflow file name 404s the dispatch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { triggerWorkflowDispatch } from '../../src/pipeline/services/CIService.js';

describe('CIService.triggerWorkflowDispatch — workflow file name', () => {
  it('hits /actions/workflows/akis-e2e.yml/dispatches', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      await triggerWorkflowDispatch('tok', 'owner', 'repo', 'proto/scaffold-123');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'POST');
    assert.match(calls[0]!.url, /\/actions\/workflows\/akis-e2e\.yml\/dispatches$/);
    // Should NOT mention the legacy name anywhere.
    assert.doesNotMatch(calls[0]!.url, /akis-tests\.yml/);
    assert.deepEqual(calls[0]!.body, { ref: 'proto/scaffold-123' });
  });
});
