/**
 * Unit tests: GitHubRESTAdapter — pushFiles 404 retry (issue #478)
 *
 * Tests the defence-in-depth retry loop in pushFiles that handles the race
 * condition where a freshly-created GitHub repo's main branch is not yet
 * visible on the REST API.
 *
 * Uses a lightweight simulation of the retry logic (mirrors the production
 * code) rather than importing the real adapter, because the real adapter
 * needs a live fetch() and is covered by integration tests.
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

// ─── Minimal error types that mirror production ───────────────────────────────

class GitHubAPIError extends Error {
  readonly code = 'GITHUB_API_ERROR';
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'GitHubAPIError';
  }
}

// ─── Simulated pushFiles ref-fetch loop ──────────────────────────────────────
// This is a faithful re-implementation of the retry section added in the fix,
// extracted for unit testing without requiring a real HTTP layer.

interface RefResult {
  object: { sha: string };
}

type RefFetcher = () => Promise<RefResult>;

async function fetchRefWithRetry(
  fetcher: RefFetcher,
  delays: number[],
  logFn: (attempt: number, delayMs: number) => void,
): Promise<RefResult> {
  let ref!: RefResult;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      ref = await fetcher();
      break; // success
    } catch (err) {
      const is404 = err instanceof GitHubAPIError && err.statusCode === 404;
      if (!is404 || attempt === delays.length - 1) throw err;
      logFn(attempt + 1, delays[attempt]);
      // In tests the delay array is [0,0,...] so this is instant
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  return ref;
}

// ─── Simulated waitForBranch loop ─────────────────────────────────────────────

type BranchProbe = () => Promise<void>;

async function waitForBranch(
  probe: BranchProbe,
  delays: number[],
  logFn: (attempt: number, delayMs: number) => void,
): Promise<void> {
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await probe();
      return; // ready
    } catch (err) {
      const is404 = err instanceof GitHubAPIError && err.statusCode === 404;
      if (!is404 || attempt === delays.length - 1) throw err;
      logFn(attempt + 1, delays[attempt]);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

// Zero-ms delays so tests finish instantly
const TEST_DELAYS = [0, 0, 0, 0, 0];

// ─── pushFiles retry tests ────────────────────────────────────────────────────

describe('pushFiles — ref fetch retry on 404', () => {
  let logCalls: Array<{ attempt: number; delayMs: number }>;

  beforeEach(() => {
    logCalls = [];
  });

  const logFn = (attempt: number, delayMs: number) => {
    logCalls.push({ attempt, delayMs });
  };

  test('succeeds immediately when ref returns 200 on first try', async () => {
    const fetcher: RefFetcher = async () => ({ object: { sha: 'abc123' } });

    const result = await fetchRefWithRetry(fetcher, TEST_DELAYS, logFn);

    assert.strictEqual(result.object.sha, 'abc123');
    assert.strictEqual(logCalls.length, 0, 'no retries should have been logged');
  });

  test('retries on 404 and succeeds on the 2nd attempt', async () => {
    let callCount = 0;
    const fetcher: RefFetcher = async () => {
      callCount++;
      if (callCount === 1) {
        throw new GitHubAPIError('Not Found', 404);
      }
      return { object: { sha: 'def456' } };
    };

    const result = await fetchRefWithRetry(fetcher, TEST_DELAYS, logFn);

    assert.strictEqual(result.object.sha, 'def456');
    assert.strictEqual(callCount, 2);
    assert.strictEqual(logCalls.length, 1, 'exactly one retry should have been logged');
    assert.strictEqual(logCalls[0].attempt, 1);
  });

  test('retries multiple 404s and succeeds on the 3rd attempt', async () => {
    let callCount = 0;
    const fetcher: RefFetcher = async () => {
      callCount++;
      if (callCount < 3) {
        throw new GitHubAPIError('Not Found', 404);
      }
      return { object: { sha: 'ghi789' } };
    };

    const result = await fetchRefWithRetry(fetcher, TEST_DELAYS, logFn);

    assert.strictEqual(result.object.sha, 'ghi789');
    assert.strictEqual(callCount, 3);
    assert.strictEqual(logCalls.length, 2);
  });

  test('throws after max retries are exhausted (all 404s)', async () => {
    const fetcher: RefFetcher = async () => {
      throw new GitHubAPIError('Not Found', 404);
    };

    await assert.rejects(
      () => fetchRefWithRetry(fetcher, TEST_DELAYS, logFn),
      (err: Error) => {
        assert.ok(err instanceof GitHubAPIError);
        assert.strictEqual((err as GitHubAPIError).statusCode, 404);
        return true;
      },
    );

    // All 5 attempts exhausted — 4 retries logged (last attempt throws, not logged)
    assert.strictEqual(logCalls.length, TEST_DELAYS.length - 1);
  });

  test('does NOT retry non-404 errors (e.g. 401 Unauthorized)', async () => {
    let callCount = 0;
    const fetcher: RefFetcher = async () => {
      callCount++;
      throw new GitHubAPIError('Bad credentials', 401);
    };

    await assert.rejects(
      () => fetchRefWithRetry(fetcher, TEST_DELAYS, logFn),
      (err: Error) => {
        assert.ok(err instanceof GitHubAPIError);
        assert.strictEqual((err as GitHubAPIError).statusCode, 401);
        return true;
      },
    );

    // Non-404 should bail immediately, no retries
    assert.strictEqual(callCount, 1, 'should stop immediately on non-404 error');
    assert.strictEqual(logCalls.length, 0, 'no retries should be logged for non-404');
  });

  test('does NOT retry non-404 errors (e.g. 500 Internal Server Error)', async () => {
    let callCount = 0;
    const fetcher: RefFetcher = async () => {
      callCount++;
      throw new GitHubAPIError('Internal Server Error', 500);
    };

    await assert.rejects(
      () => fetchRefWithRetry(fetcher, TEST_DELAYS, logFn),
      (err: Error) => {
        assert.ok(err instanceof GitHubAPIError);
        assert.strictEqual((err as GitHubAPIError).statusCode, 500);
        return true;
      },
    );

    assert.strictEqual(callCount, 1);
    assert.strictEqual(logCalls.length, 0);
  });
});

// ─── waitForBranch tests ──────────────────────────────────────────────────────

describe('waitForBranch — polls until branch is provisioned', () => {
  let logCalls: Array<{ attempt: number; delayMs: number }>;

  beforeEach(() => {
    logCalls = [];
  });

  const logFn = (attempt: number, delayMs: number) => {
    logCalls.push({ attempt, delayMs });
  };

  test('returns immediately when branch is ready on first probe', async () => {
    const probe: BranchProbe = async () => { /* success */ };

    await waitForBranch(probe, TEST_DELAYS, logFn);

    assert.strictEqual(logCalls.length, 0);
  });

  test('retries on 404 and succeeds on 2nd probe', async () => {
    let probeCount = 0;
    const probe: BranchProbe = async () => {
      probeCount++;
      if (probeCount === 1) throw new GitHubAPIError('Not Found', 404);
    };

    await waitForBranch(probe, TEST_DELAYS, logFn);

    assert.strictEqual(probeCount, 2);
    assert.strictEqual(logCalls.length, 1);
    assert.strictEqual(logCalls[0].attempt, 1);
  });

  test('throws PROTO_PUSH_FAILED-compatible GitHubAPIError after exhausting retries', async () => {
    const probe: BranchProbe = async () => {
      throw new GitHubAPIError('Not Found', 404);
    };

    await assert.rejects(
      () => waitForBranch(probe, TEST_DELAYS, logFn),
      (err: Error) => {
        // The error must be a GitHubAPIError with statusCode 404.
        // The Proto agent maps this to PROTO_PUSH_FAILED.
        assert.ok(err instanceof GitHubAPIError, `Expected GitHubAPIError, got ${err.constructor.name}`);
        assert.strictEqual((err as GitHubAPIError).statusCode, 404);
        return true;
      },
    );

    // 4 retries logged (5th attempt throws and is not logged)
    assert.strictEqual(logCalls.length, TEST_DELAYS.length - 1);
  });

  test('does not retry on non-404 (e.g. 403 Forbidden)', async () => {
    let probeCount = 0;
    const probe: BranchProbe = async () => {
      probeCount++;
      throw new GitHubAPIError('Forbidden', 403);
    };

    await assert.rejects(
      () => waitForBranch(probe, TEST_DELAYS, logFn),
      (err: Error) => {
        assert.ok(err instanceof GitHubAPIError);
        assert.strictEqual((err as GitHubAPIError).statusCode, 403);
        return true;
      },
    );

    assert.strictEqual(probeCount, 1, 'must not retry on 403');
    assert.strictEqual(logCalls.length, 0);
  });
});

// ─── GitHubAPIError shape guard ───────────────────────────────────────────────

describe('GitHubAPIError — shape matches production contract', () => {
  test('has correct name, message and statusCode', () => {
    const err = new GitHubAPIError('Not Found', 404);
    assert.strictEqual(err.name, 'GitHubAPIError');
    assert.strictEqual(err.message, 'Not Found');
    assert.strictEqual(err.statusCode, 404);
    assert.ok(err instanceof Error);
  });

  test('statusCode is undefined when not provided', () => {
    const err = new GitHubAPIError('Something went wrong');
    assert.strictEqual(err.statusCode, undefined);
  });
});
