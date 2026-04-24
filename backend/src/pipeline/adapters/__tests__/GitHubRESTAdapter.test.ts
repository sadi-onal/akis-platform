import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRESTAdapter } from '../GitHubRESTAdapter.js';
import { GitHubTokenInvalidError, GitHubAPIError } from '../../core/contracts/PipelineErrors.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replace global `fetch` with a stub for the duration of `fn`, then restore it.
 */
async function withFetchStub(
  stub: typeof globalThis.fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function makeFetchReturning(status: number, body: unknown): typeof globalThis.fetch {
  return async () => {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: async () => text,
      json: async () => body,
    } as unknown as Response;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubRESTAdapter.createRepository', () => {
  it('throws GitHubTokenInvalidError when POST /user/repos returns 404', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'invalid-token' });

    await withFetchStub(
      makeFetchReturning(404, { message: 'Not Found' }),
      async () => {
        await assert.rejects(
          () => adapter.createRepository('testowner', 'my-repo', false),
          (err: unknown) => {
            assert.ok(
              err instanceof GitHubTokenInvalidError,
              `Expected GitHubTokenInvalidError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
            );
            assert.equal(err.code, 'GITHUB_TOKEN_INVALID');
            assert.equal(err.retryable, false);
            assert.equal(err.recoveryAction, 'reconnect_github');
            return true;
          },
        );
      },
    );
  });

  it('does NOT throw GitHubTokenInvalidError for non-404 GitHub errors (e.g. 422)', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'some-token' });

    await withFetchStub(
      makeFetchReturning(422, { message: 'Repository creation failed.' }),
      async () => {
        await assert.rejects(
          () => adapter.createRepository('testowner', 'my-repo', false),
          (err: unknown) => {
            // Should be a plain GitHubAPIError, not the token-invalid variant
            assert.ok(
              err instanceof GitHubAPIError,
              `Expected GitHubAPIError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
            );
            assert.ok(
              !(err instanceof GitHubTokenInvalidError),
              'Should NOT be GitHubTokenInvalidError for 422',
            );
            return true;
          },
        );
      },
    );
  });
});
