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
  fn: () => Promise<void>
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

describe('GitHubRESTAdapter.repoExists', () => {
  it('returns true when GET /repos/{owner}/{repo} responds 200', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'tok' });

    await withFetchStub(
      makeFetchReturning(200, { id: 12345, name: 'qr-kod-uretici' }),
      async () => {
        const exists = await adapter.repoExists!('testowner', 'qr-kod-uretici');
        assert.equal(exists, true);
      }
    );
  });

  it('returns false when GET /repos/{owner}/{repo} responds 404', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'tok' });

    await withFetchStub(makeFetchReturning(404, { message: 'Not Found' }), async () => {
      const exists = await adapter.repoExists!('testowner', 'qr-kod-uretici');
      assert.equal(exists, false);
    });
  });

  it('propagates non-404 errors (caller decides whether to fall back)', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'tok' });

    await withFetchStub(makeFetchReturning(500, { message: 'Internal Server Error' }), async () => {
      await assert.rejects(
        () => adapter.repoExists!('testowner', 'qr-kod-uretici'),
        (err: unknown) => {
          assert.ok(err instanceof GitHubAPIError);
          return true;
        }
      );
    });
  });
});

// PR-V-github-401-graceful — when GitHub returns 401 on ANY endpoint, the
// adapter throws GitHubTokenInvalidError so the orchestrator can render the
// "GitHub Bağlantısını Yenile" CTA + clear the stale row from
// `github_integrations`. Generic GitHubAPIError would be retried by FixLoop
// and the user would only see "Üretilen kod GitHub'dan okunamadı".
describe('GitHubRESTAdapter ghFetch 401 handling', () => {
  it('throws GitHubTokenInvalidError when ANY endpoint returns 401', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'expired-token' });

    await withFetchStub(makeFetchReturning(401, { message: 'Bad credentials' }), async () => {
      // listFiles is the path that 401s in the real-world bug report
      // (pipeline 592d97d0... — Trace tried to read code, GitHub returned
      // 401, pipeline got stuck on TRACE_CODE_READ_FAILED).
      await assert.rejects(
        () => adapter.listFiles('testowner', 'qr-kod', 'main'),
        (err: unknown) => {
          assert.ok(
            err instanceof GitHubTokenInvalidError,
            `Expected GitHubTokenInvalidError, got ${err instanceof Error ? err.constructor.name : String(err)}`
          );
          assert.equal(err.code, 'GITHUB_TOKEN_INVALID');
          assert.equal(err.retryable, false);
          assert.equal(err.recoveryAction, 'reconnect_github');
          return true;
        }
      );
    });
  });

  it('throws GitHubTokenInvalidError when getFileContent endpoint returns 401', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'expired-token' });

    await withFetchStub(makeFetchReturning(401, { message: 'Bad credentials' }), async () => {
      await assert.rejects(
        () => adapter.getFileContent('testowner', 'qr-kod', 'main', 'src/index.ts'),
        (err: unknown) => {
          assert.ok(err instanceof GitHubTokenInvalidError);
          return true;
        }
      );
    });
  });

  it('does NOT throw GitHubTokenInvalidError for a 500 server error', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'valid-token' });

    await withFetchStub(makeFetchReturning(500, { message: 'Internal Server Error' }), async () => {
      await assert.rejects(
        () => adapter.listFiles('testowner', 'qr-kod', 'main'),
        (err: unknown) => {
          // 500 should remain a generic GitHubAPIError so outer code retries.
          assert.ok(err instanceof GitHubAPIError);
          assert.ok(
            !(err instanceof GitHubTokenInvalidError),
            'Should NOT promote a 500 to GitHubTokenInvalidError'
          );
          return true;
        }
      );
    });
  });
});

describe('GitHubRESTAdapter.createRepository', () => {
  it('throws GitHubTokenInvalidError when POST /user/repos returns 404', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'invalid-token' });

    await withFetchStub(makeFetchReturning(404, { message: 'Not Found' }), async () => {
      await assert.rejects(
        () => adapter.createRepository('testowner', 'my-repo', false),
        (err: unknown) => {
          assert.ok(
            err instanceof GitHubTokenInvalidError,
            `Expected GitHubTokenInvalidError, got ${err instanceof Error ? err.constructor.name : String(err)}`
          );
          assert.equal(err.code, 'GITHUB_TOKEN_INVALID');
          assert.equal(err.retryable, false);
          assert.equal(err.recoveryAction, 'reconnect_github');
          return true;
        }
      );
    });
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
              `Expected GitHubAPIError, got ${err instanceof Error ? err.constructor.name : String(err)}`
            );
            assert.ok(
              !(err instanceof GitHubTokenInvalidError),
              'Should NOT be GitHubTokenInvalidError for 422'
            );
            return true;
          }
        );
      }
    );
  });
});
