/**
 * JiraMCPService — JSON-RPC failure-mode coverage
 *
 * The pipeline relies on Jira being able to fail without breaking the user's
 * pipeline (Epic creation + Proto/Trace comments are non-fatal). These tests
 * pin the two failure paths that were untested before this PR:
 *   1. Network timeout (HttpClient.post rejects with an AbortError-shaped error)
 *   2. JSON-RPC payload missing both `result` and `error` keys
 *
 * No real network. No real OAuth. We inject a fake `HttpClient` via the
 * constructor seam — JiraMCPService accepts `opts.httpClient`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraMCPService } from '../../src/services/mcp/adapters/JiraMCPService.ts';

type FakePostResult =
  | { kind: 'response'; status: number; statusText: string; body: unknown }
  | { kind: 'reject'; error: Error };

function makeFakeHttpClient(plan: FakePostResult[]) {
  let i = 0;
  const calls: Array<{ url: string; payload: unknown; token?: string }> = [];
  return {
    calls,
    async post(url: string, payload: unknown, token?: string): Promise<Response> {
      calls.push({ url, payload, token });
      const next = plan[i++] ?? plan[plan.length - 1];
      if (next.kind === 'reject') {
        throw next.error;
      }
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        statusText: next.statusText,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

describe('JiraMCPService — failure modes', () => {
  it('surfaces a network timeout (HttpClient post throws AbortError)', async () => {
    const fake = makeFakeHttpClient([
      { kind: 'reject', error: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    ]);

    const service = new JiraMCPService({
      baseUrl: 'https://example.invalid/mcp',
      token: 'fake-token',
      // The constructor accepts an injected httpClient (typed as HttpClient,
      // but structurally only `post()` is used).
      httpClient: fake as unknown as import('../../src/services/http/HttpClient.ts').HttpClient,
    });

    await assert.rejects(
      service.createIssue('AKIS', { summary: 'test', issueType: 'Epic' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message.toLowerCase(), /abort/);
        return true;
      }
    );

    assert.equal(fake.calls.length, 1, 'service must call post exactly once for a single createIssue invocation');
  });

  it('throws a structured error when JSON-RPC payload returns an `error` envelope', async () => {
    const fake = makeFakeHttpClient([
      { kind: 'response', status: 200, statusText: 'OK', body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'Internal MCP error' },
      } },
    ]);

    const service = new JiraMCPService({
      baseUrl: 'https://example.invalid/mcp',
      token: 'fake-token',
      httpClient: fake as unknown as import('../../src/services/http/HttpClient.ts').HttpClient,
    });

    await assert.rejects(
      service.createIssue('AKIS', { summary: 'test', issueType: 'Epic' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Jira MCP Error/);
        assert.match(err.message, /-32603/);
        assert.match(err.message, /Internal MCP error/);
        return true;
      }
    );
  });

  it('throws when the HTTP response is non-2xx', async () => {
    const fake = makeFakeHttpClient([
      { kind: 'response', status: 503, statusText: 'Service Unavailable', body: { error: 'down' } },
    ]);

    const service = new JiraMCPService({
      baseUrl: 'https://example.invalid/mcp',
      token: 'fake-token',
      httpClient: fake as unknown as import('../../src/services/http/HttpClient.ts').HttpClient,
    });

    await assert.rejects(
      service.createIssue('AKIS', { summary: 'test', issueType: 'Epic' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Jira MCP Request failed/);
        assert.match(err.message, /503/);
        return true;
      }
    );
  });

  it('passes through a 200 response with a result envelope (happy path control)', async () => {
    const fake = makeFakeHttpClient([
      { kind: 'response', status: 200, statusText: 'OK', body: {
        jsonrpc: '2.0',
        id: 1,
        result: { key: 'AKIS-1', id: '10001' },
      } },
    ]);

    const service = new JiraMCPService({
      baseUrl: 'https://example.invalid/mcp',
      token: 'fake-token',
      httpClient: fake as unknown as import('../../src/services/http/HttpClient.ts').HttpClient,
    });

    const out = await service.createIssue('AKIS', { summary: 'test', issueType: 'Epic' });
    assert.equal(out.key, 'AKIS-1');
    assert.equal(out.id, '10001');
  });
});
