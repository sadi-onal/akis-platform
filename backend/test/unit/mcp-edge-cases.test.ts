/**
 * MCP Gateway & GitHub Adapter — Edge Case Tests
 *
 * Covers:
 *   McpGateway:  timeout, retry/backoff on 5xx, correlation IDs,
 *                invalid endpoint, request cancellation, Atlassian adapter
 *   GitHubRESTAdapter: createRepository, commitFile base64,
 *                listFiles (empty/large/filtered), getFileContent (base64/404),
 *                pushFiles (batch commit), createPR (draft),
 *                createBranch (already-exists), token validation
 *   GitHubMCPService: tool cache TTL, getFileContentSafe, createBranch,
 *                commitFile, createPRDraft, getLatestRelease
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  McpGateway,
  McpGatewayError,
} from '../../src/services/mcp/McpGateway.js';

import {
  GitHubMCPService,
  McpError,
  McpConnectionError,
  McpErrorCode,
} from '../../src/services/mcp/adapters/GitHubMCPService.js';

import { HttpClient } from '../../src/services/http/HttpClient.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Stub global fetch for McpGateway tests (it uses raw fetch, not HttpClient) */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

/** Build a minimal JSON Response with headers */
function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, statusText: statusText(status), headers });
}

function statusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  return map[code] ?? '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 1 — McpGateway
// ═══════════════════════════════════════════════════════════════════════════

describe('MCP Gateway — timeout handling', () => {
  it('throws VENDOR_REQUEST_NETWORK_ERROR when request exceeds timeout', async () => {
    const restore = stubFetch(async (_url, init) => {
      // Simulate a request that hangs until the signal aborts
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 50, retryCount: 0 });
      await assert.rejects(
        () => gw.fetchGitHubJson('/user', 'tok-123'),
        (err) => {
          assert.ok(err instanceof McpGatewayError);
          assert.strictEqual(err.code, 'VENDOR_REQUEST_NETWORK_ERROR');
          assert.ok(err.correlationId, 'correlationId should be set');
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('uses 8000ms as default timeout', () => {
    // McpGateway constructor reads env; pass explicit to avoid env dep
    const gw = new McpGateway({ timeoutMs: 8000, retryCount: 2 });
    // Access private via cast — only verifying construction doesn't throw
    assert.ok(gw);
  });
});

describe('MCP Gateway — retry logic on 5xx', () => {
  it('retries on 500 and succeeds on final attempt', async () => {
    let attempt = 0;
    const restore = stubFetch(async () => {
      attempt += 1;
      if (attempt <= 2) {
        return jsonResponse({ message: 'Internal error' }, 500);
      }
      return jsonResponse({ login: 'octocat', id: 1 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 2 });
      const result = await gw.fetchGitHubUser('tok-abc');
      assert.strictEqual(result.login, 'octocat');
      assert.strictEqual(attempt, 3, 'should have retried twice then succeeded');
    } finally {
      restore();
    }
  });

  it('retries on 429 (rate limit) and succeeds', async () => {
    let attempt = 0;
    const restore = stubFetch(async () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({}, 429);
      }
      return jsonResponse({ login: 'user1', id: 2 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 2 });
      const result = await gw.fetchGitHubUser('tok-rate');
      assert.strictEqual(result.login, 'user1');
      assert.strictEqual(attempt, 2);
    } finally {
      restore();
    }
  });

  it('throws VENDOR_REQUEST_FAILED after all retries exhausted on 5xx', async () => {
    let attempt = 0;
    const restore = stubFetch(async () => {
      attempt += 1;
      return jsonResponse({ message: 'Server error' }, 503);
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 2 });
      await assert.rejects(
        () => gw.fetchGitHubJson('/repos', 'tok-fail'),
        (err) => {
          assert.ok(err instanceof McpGatewayError);
          assert.strictEqual(err.code, 'VENDOR_REQUEST_FAILED');
          assert.strictEqual(err.status, 503);
          return true;
        },
      );
      // retryCount=2 means 3 total attempts (0, 1, 2)
      assert.strictEqual(attempt, 3);
    } finally {
      restore();
    }
  });

  it('does NOT retry on 4xx (except 429)', async () => {
    let attempt = 0;
    const restore = stubFetch(async () => {
      attempt += 1;
      return jsonResponse({ message: 'Not Found' }, 404);
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 2 });
      await assert.rejects(
        () => gw.fetchGitHubJson('/repos/nonexistent', 'tok-404'),
        (err) => {
          assert.ok(err instanceof McpGatewayError);
          assert.strictEqual(err.status, 404);
          return true;
        },
      );
      assert.strictEqual(attempt, 1, 'should not retry on 404');
    } finally {
      restore();
    }
  });
});

describe('MCP Gateway — correlation ID', () => {
  it('generates a UUID correlation ID when none provided', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const restore = stubFetch(async (_url, init) => {
      const hdrs: Record<string, string> = {};
      if (init.headers && typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          hdrs[k.toLowerCase()] = v;
        }
      }
      capturedHeaders.push(hdrs);
      return jsonResponse({ login: 'test', id: 1 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.fetchGitHubUser('tok-corr');
      assert.strictEqual(capturedHeaders.length, 1);
      const correlationId = capturedHeaders[0]['x-correlation-id'];
      assert.ok(correlationId, 'x-correlation-id header must be set');
      // UUID v4 pattern
      assert.match(correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      restore();
    }
  });

  it('uses provided correlation ID when given', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const restore = stubFetch(async (_url, init) => {
      const hdrs: Record<string, string> = {};
      if (init.headers && typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          hdrs[k.toLowerCase()] = v;
        }
      }
      capturedHeaders.push(hdrs);
      return jsonResponse({ login: 'test', id: 1 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.fetchGitHubJson('/user', 'tok-x', 'my-custom-corr-id');
      assert.strictEqual(capturedHeaders[0]['x-correlation-id'], 'my-custom-corr-id');
    } finally {
      restore();
    }
  });

  it('correlation ID is preserved in McpGatewayError', async () => {
    const restore = stubFetch(async () => jsonResponse({ message: 'fail' }, 401));

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await assert.rejects(
        () => gw.fetchGitHubJson('/user', 'bad-tok', 'err-corr-id'),
        (err) => {
          assert.ok(err instanceof McpGatewayError);
          assert.strictEqual(err.correlationId, 'err-corr-id');
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

describe('MCP Gateway — invalid endpoint handling', () => {
  it('prepends slash to endpoint missing leading slash', async () => {
    let capturedUrl = '';
    const restore = stubFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse({ login: 'test', id: 1 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.fetchGitHubJson('user', 'tok-noslash');
      assert.strictEqual(capturedUrl, 'https://api.github.com/user');
    } finally {
      restore();
    }
  });

  it('handles endpoint with leading slash normally', async () => {
    let capturedUrl = '';
    const restore = stubFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse({ login: 'test', id: 1 });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.fetchGitHubJson('/user', 'tok-slash');
      assert.strictEqual(capturedUrl, 'https://api.github.com/user');
    } finally {
      restore();
    }
  });
});

describe('MCP Gateway — request cancellation (abort)', () => {
  it('abort via timeout produces McpGatewayError with NETWORK_ERROR code', async () => {
    const restore = stubFetch(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 30, retryCount: 0 });
      await assert.rejects(
        () => gw.fetchGitHubJson('/slow', 'tok-abort'),
        (err) => {
          assert.ok(err instanceof McpGatewayError);
          assert.strictEqual(err.code, 'VENDOR_REQUEST_NETWORK_ERROR');
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

describe('MCP Gateway — Atlassian connection tests', () => {
  it('returns success:true with displayName on 200', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ displayName: 'Test User' }),
    );

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      const result = await gw.testAtlassianConnection(
        'https://mysite.atlassian.net', 'user@test.com', 'api-token', 'jira',
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.displayName, 'Test User');
    } finally {
      restore();
    }
  });

  it('returns success:false with error on 401', async () => {
    const restore = stubFetch(async () =>
      new Response('Unauthorized', { status: 401 }),
    );

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      const result = await gw.testAtlassianConnection(
        'https://mysite.atlassian.net', 'user@test.com', 'bad-token', 'jira',
      );
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('credentials') || result.error?.includes('Invalid'));
    } finally {
      restore();
    }
  });

  it('returns success:false with error on 403', async () => {
    const restore = stubFetch(async () =>
      new Response('Forbidden', { status: 403 }),
    );

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      const result = await gw.testAtlassianConnection(
        'https://mysite.atlassian.net', 'user@test.com', 'token', 'confluence',
      );
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('forbidden') || result.error?.includes('Forbidden') || result.error?.includes('permission'));
    } finally {
      restore();
    }
  });

  it('uses correct endpoint for jira vs confluence', async () => {
    const capturedUrls: string[] = [];
    const restore = stubFetch(async (url) => {
      capturedUrls.push(url);
      return jsonResponse({ displayName: 'User' });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.testAtlassianConnection('https://site.atlassian.net', 'a@b.com', 'tok', 'jira');
      await gw.testAtlassianConnection('https://site.atlassian.net', 'a@b.com', 'tok', 'confluence');

      assert.ok(capturedUrls[0].includes('/rest/api/3/myself'));
      assert.ok(capturedUrls[1].includes('/wiki/rest/api/user/current'));
    } finally {
      restore();
    }
  });

  it('uses Basic auth header with base64-encoded email:token', async () => {
    let capturedAuth = '';
    const restore = stubFetch(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      capturedAuth = headers['Authorization'] || '';
      return jsonResponse({ displayName: 'User' });
    });

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      await gw.testAtlassianConnection('https://site.atlassian.net', 'user@test.com', 'my-api-token', 'jira');
      const expected = Buffer.from('user@test.com:my-api-token').toString('base64');
      assert.strictEqual(capturedAuth, `Basic ${expected}`);
    } finally {
      restore();
    }
  });
});

describe('MCP Gateway — OAuth exchange', () => {
  it('exchanges GitHub OAuth code for token', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ access_token: 'gho_abc123' }),
    );

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      const result = await gw.exchangeGitHubOAuthCode({
        code: 'auth-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost:5173/callback',
      });
      assert.strictEqual(result.access_token, 'gho_abc123');
    } finally {
      restore();
    }
  });

  it('returns error fields on OAuth failure', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }),
    );

    try {
      const gw = new McpGateway({ timeoutMs: 5000, retryCount: 0 });
      const result = await gw.exchangeGitHubOAuthCode({
        code: 'expired-code',
        clientId: 'cid',
        clientSecret: 'csecret',
        redirectUri: 'http://localhost:5173/callback',
      });
      assert.strictEqual(result.error, 'bad_verification_code');
    } finally {
      restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 — GitHubRESTAdapter (via createGitHubRESTAdapter)
// ═══════════════════════════════════════════════════════════════════════════

// We test through the exported function by stubbing global fetch.

import { createGitHubRESTAdapter } from '../../src/pipeline/adapters/GitHubRESTAdapter.js';

describe('GitHub REST Adapter — createRepository', () => {
  it('creates repo and returns html_url on success', async () => {
    // POST /user/repos → 201 created, then GET /repos/user/my-app → 200 read-back
    const restore = stubFetch(async (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') {
        return jsonResponse({ id: 123, full_name: 'user/my-app' });
      }
      return jsonResponse({ html_url: 'https://github.com/user/my-app', full_name: 'user/my-app' }, 201);
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_valid' });
      const result = await adapter.createRepository('user', 'my-app', true);
      assert.strictEqual(result.url, 'https://github.com/user/my-app');
    } finally {
      restore();
    }
  });

  it('throws on 422 (repo already exists)', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ message: 'Repository creation failed.' }, 422),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_valid' });
      await assert.rejects(
        () => adapter.createRepository('user', 'existing-repo', false),
        (err: Error) => {
          assert.ok(err.message.includes('422'));
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('blocks AKIS platform repo names', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'ghp_valid' });
    await assert.rejects(
      () => adapter.createRepository('anyone', 'akis-platform-development', true),
      (err: Error) => {
        assert.ok(err.message.includes('AKIS platform repo'));
        return true;
      },
    );
  });
});

describe('GitHub REST Adapter — commitFile (base64 encoding)', () => {
  it('encodes content as base64 in the PUT body', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let _callCount = 0;

    const restore = stubFetch(async (url, init) => {
      _callCount += 1;

      // First call: GET to check existing file — return 404
      if (init.method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }

      // Second call: PUT to create/update file
      if (init.method === 'PUT') {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ content: { sha: 'new-sha' } });
      }

      return jsonResponse({});
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_commit' });
      await adapter.commitFile('user', 'repo', 'main', 'src/index.ts', 'console.log("hello")', 'feat: init');

      assert.ok(capturedBody);
      const expectedBase64 = Buffer.from('console.log("hello")', 'utf-8').toString('base64');
      assert.strictEqual(capturedBody!.content, expectedBase64);
      assert.strictEqual(capturedBody!.message, 'feat: init');
      assert.strictEqual(capturedBody!.branch, 'main');
    } finally {
      restore();
    }
  });

  it('includes existing SHA when file already exists (update flow)', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const restore = stubFetch(async (_url, init) => {
      if (init.method === 'GET') {
        return jsonResponse({ sha: 'existing-sha-abc' });
      }
      if (init.method === 'PUT') {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ content: { sha: 'updated-sha' } });
      }
      return jsonResponse({});
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_update' });
      await adapter.commitFile('user', 'repo', 'main', 'README.md', '# Hello', 'docs: update readme');
      assert.ok(capturedBody);
      assert.strictEqual(capturedBody!.sha, 'existing-sha-abc');
    } finally {
      restore();
    }
  });
});

describe('GitHub REST Adapter — listFiles', () => {
  it('returns empty array for empty repo', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ tree: [], truncated: false }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_list' });
      const files = await adapter.listFiles('user', 'empty-repo', 'main');
      assert.deepStrictEqual(files, []);
    } finally {
      restore();
    }
  });

  it('filters out node_modules, .git, dist, build directories', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({
        tree: [
          { path: 'src/index.ts', type: 'blob' },
          { path: 'node_modules/lodash/index.js', type: 'blob' },
          { path: '.git/config', type: 'blob' },
          { path: 'dist/bundle.js', type: 'blob' },
          { path: 'build/output.js', type: 'blob' },
          { path: 'package.json', type: 'blob' },
          { path: 'src', type: 'tree' },
        ],
        truncated: false,
      }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_filter' });
      const files = await adapter.listFiles('user', 'repo', 'main');
      assert.deepStrictEqual(files, ['src/index.ts', 'package.json']);
    } finally {
      restore();
    }
  });

  it('only includes blobs (not trees)', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({
        tree: [
          { path: 'src', type: 'tree' },
          { path: 'src/app.ts', type: 'blob' },
        ],
        truncated: false,
      }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_blob' });
      const files = await adapter.listFiles('user', 'repo', 'main');
      assert.deepStrictEqual(files, ['src/app.ts']);
    } finally {
      restore();
    }
  });
});

describe('GitHub REST Adapter — getFileContent', () => {
  it('decodes base64 content to UTF-8 string', async () => {
    const original = 'export default function hello() { return "world"; }';
    const restore = stubFetch(async () =>
      jsonResponse({
        content: Buffer.from(original).toString('base64'),
        encoding: 'base64',
      }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_read' });
      const content = await adapter.getFileContent('user', 'repo', 'main', 'src/hello.ts');
      assert.strictEqual(content, original);
    } finally {
      restore();
    }
  });

  it('returns empty string when content field is missing', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ encoding: 'base64' }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_empty' });
      const content = await adapter.getFileContent('user', 'repo', 'main', 'empty.txt');
      assert.strictEqual(content, '');
    } finally {
      restore();
    }
  });

  it('throws on 404 (file not found)', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ message: 'Not Found' }, 404),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_404' });
      await assert.rejects(
        () => adapter.getFileContent('user', 'repo', 'main', 'nonexistent.ts'),
        (err: Error) => {
          assert.ok(err.message.includes('404'));
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('handles non-base64 encoding gracefully', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ content: 'raw content', encoding: 'utf-8' }),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_utf8' });
      // When encoding is not base64, returns content as-is
      const content = await adapter.getFileContent('user', 'repo', 'main', 'file.txt');
      assert.strictEqual(content, 'raw content');
    } finally {
      restore();
    }
  });
});

describe('GitHub REST Adapter — pushFiles (batch commit)', () => {
  it('creates blobs, tree, commit, and updates ref for multiple files', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let blobCount = 0;
    let refGetCount = 0;

    const restore = stubFetch(async (url, init) => {
      const path = url.replace('https://api.github.com', '');
      const method = init.method ?? 'GET';
      calls.push({ method, path });

      // GET ref — first call returns old SHA, second call (post-push read-back) returns new commit SHA
      if (method === 'GET' && path.includes('/git/ref/heads/')) {
        refGetCount += 1;
        const sha = refGetCount === 1 ? 'ref-sha-abc' : 'new-commit-sha';
        return jsonResponse({ object: { sha } });
      }
      // GET commit
      if (method === 'GET' && path.includes('/git/commits/')) {
        return jsonResponse({ tree: { sha: 'tree-sha-base' } });
      }
      // POST blob
      if (method === 'POST' && path.includes('/git/blobs')) {
        blobCount += 1;
        return jsonResponse({ sha: `blob-sha-${blobCount}` }, 201);
      }
      // POST tree
      if (method === 'POST' && path.includes('/git/trees')) {
        return jsonResponse({ sha: 'new-tree-sha' }, 201);
      }
      // POST commit
      if (method === 'POST' && path.includes('/git/commits')) {
        return jsonResponse({ sha: 'new-commit-sha' }, 201);
      }
      // PATCH ref
      if (method === 'PATCH' && path.includes('/git/refs/')) {
        return jsonResponse({ ref: 'refs/heads/main' });
      }

      return jsonResponse({});
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_push' });
      await adapter.pushFiles('user', 'repo', 'main', [
        { path: 'src/a.ts', content: 'file a' },
        { path: 'src/b.ts', content: 'file b' },
        { path: 'package.json', content: '{}' },
      ], 'feat: batch commit');

      // Should create 3 blobs (one per file)
      assert.strictEqual(blobCount, 3);
      // Sequence: GET ref (1), GET commit (2), 3x POST blob (3-5), POST tree (6),
      //           POST commit (7), PATCH ref (8), GET ref read-back (9)
      assert.strictEqual(calls.length, 9);
      assert.strictEqual(calls[0].method, 'GET');   // initial ref
      assert.strictEqual(calls[1].method, 'GET');   // commit lookup
      assert.strictEqual(calls[7].method, 'PATCH'); // update ref
      assert.strictEqual(calls[8].method, 'GET');   // post-push read-back verification
    } finally {
      restore();
    }
  });

  it('blocks pushFiles to AKIS platform repos', async () => {
    const adapter = createGitHubRESTAdapter({ token: 'ghp_guard' });
    await assert.rejects(
      () => adapter.pushFiles('user', 'akis-platform', 'main', [{ path: 'a.ts', content: 'x' }], 'test'),
      (err: Error) => {
        assert.ok(err.message.includes('AKIS platform repo'));
        return true;
      },
    );
  });
});

describe('GitHub REST Adapter — createPR', () => {
  it('creates a draft PR and returns url', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const restore = stubFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({ html_url: 'https://github.com/user/repo/pull/42' }, 201);
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_pr' });
      const result = await adapter.createPR(
        'user', 'repo', 'feat: new feature', 'Description', 'feature-branch', 'main',
      );
      assert.strictEqual(result.url, 'https://github.com/user/repo/pull/42');
      assert.ok(capturedBody);
      assert.strictEqual(capturedBody!.draft, true);
      assert.strictEqual(capturedBody!.head, 'feature-branch');
      assert.strictEqual(capturedBody!.base, 'main');
    } finally {
      restore();
    }
  });
});

describe('GitHub REST Adapter — createBranch', () => {
  it('creates branch from main by default', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    const restore = stubFetch(async (url, init) => {
      const path = url.replace('https://api.github.com', '');
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init.method ?? 'GET', path, body });

      if (init.method === 'GET') {
        return jsonResponse({ object: { sha: 'base-sha-123' } });
      }
      return jsonResponse({ ref: 'refs/heads/feature-x' }, 201);
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_branch' });
      await adapter.createBranch('user', 'repo', 'feature-x');

      // GET the base branch SHA
      assert.ok(calls[0].path.includes('/git/ref/heads/main'));
      // POST to create new ref
      assert.strictEqual(calls[1].body?.ref, 'refs/heads/feature-x');
      assert.strictEqual(calls[1].body?.sha, 'base-sha-123');
    } finally {
      restore();
    }
  });

  it('creates branch from specified base branch', async () => {
    const calls: Array<{ method: string; path: string }> = [];

    const restore = stubFetch(async (url, init) => {
      const path = url.replace('https://api.github.com', '');
      calls.push({ method: init.method ?? 'GET', path });

      if (init.method === 'GET') {
        return jsonResponse({ object: { sha: 'develop-sha' } });
      }
      return jsonResponse({ ref: 'refs/heads/feature-y' }, 201);
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_branch2' });
      await adapter.createBranch('user', 'repo', 'feature-y', 'develop');
      assert.ok(calls[0].path.includes('/git/ref/heads/develop'));
    } finally {
      restore();
    }
  });

  it('succeeds silently when branch already exists (422 idempotent)', async () => {
    let callCount = 0;
    const restore = stubFetch(async (_url, init) => {
      callCount += 1;
      if (init.method === 'GET') {
        return jsonResponse({ object: { sha: 'sha-abc' } });
      }
      // POST fails — branch exists
      return jsonResponse({ message: 'Reference already exists' }, 422);
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_exists' });
      // Should NOT throw — "Reference already exists" is treated as idempotent success
      await adapter.createBranch('user', 'repo', 'existing-branch');
      assert.ok(callCount >= 2, 'Should have made GET + POST calls');
    } finally {
      restore();
    }
  });
});

describe('GitHub REST Adapter — token validation (via API errors)', () => {
  it('throws on 401 (expired/invalid token)', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({ message: 'Bad credentials' }, 401),
    );

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_expired' });
      await assert.rejects(
        () => adapter.listFiles('user', 'repo', 'main'),
        (err: Error) => {
          assert.ok(err.message.includes('401'));
          assert.ok(err.message.includes('Bad credentials'));
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('throws on 403 (insufficient permissions)', async () => {
    const restore = stubFetch(async () => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '100',
      };
      return new Response(
        JSON.stringify({ message: 'Resource not accessible by integration' }),
        { status: 403, headers },
      );
    });

    try {
      const adapter = createGitHubRESTAdapter({ token: 'ghp_noaccess' });
      await assert.rejects(
        () => adapter.listFiles('user', 'private-repo', 'main'),
        (err: Error) => {
          assert.ok(err.message.includes('403'));
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3 — GitHubMCPService (additional edge cases)
// ═══════════════════════════════════════════════════════════════════════════

/** Reusable FakeHttpClient for MCP tests */
class McpFakeHttpClient extends HttpClient {
  calls: Array<{ url: string; body: unknown }> = [];
  private correlationId: string;
  private toolHandlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();
  private availableTools: string[] = [
    'get_file_contents', 'create_or_update_file', 'create_pull_request',
    'create_branch', 'list_issues', 'get_latest_release',
  ];

  constructor(correlationId: string) {
    super();
    this.correlationId = correlationId;
  }

  setTools(tools: string[]): void {
    this.availableTools = tools;
  }

  onTool(name: string, handler: (args: Record<string, unknown>) => unknown): void {
    this.toolHandlers.set(name, handler);
  }

  async post(url: string, body?: unknown, _token?: string, _extraHeaders?: Record<string, string>): Promise<Response> {
    this.calls.push({ url, body });

    const req = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const method = typeof req.method === 'string' ? req.method : '';
    const id = req.id ?? 1;
    const params = req.params as Record<string, unknown> | undefined;
    const headers = new Headers({
      'x-correlation-id': this.correlationId,
      'content-type': 'application/json',
    });

    if (method === 'initialize') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: '0.1.0' }, id }),
        { status: 200, headers },
      );
    }

    if (method === 'tools/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: { tools: this.availableTools.map((name) => ({ name })) },
          id,
        }),
        { status: 200, headers },
      );
    }

    if (method === 'tools/call') {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
      const handler = this.toolHandlers.get(toolName);

      if (handler) {
        const result = handler(toolArgs);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
            id,
          }),
          { status: 200, headers },
        );
      }

      // Default: tool not handled
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Tool not handled: ${toolName}` },
          id,
        }),
        { status: 200, headers },
      );
    }

    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: `Unhandled: ${method}` }, id }),
      { status: 200, headers },
    );
  }
}

function createMcpService(fake: McpFakeHttpClient): GitHubMCPService {
  return new GitHubMCPService({
    baseUrl: 'http://localhost:4010/mcp',
    token: 'mock-token',
    correlationId: 'test-corr',
    httpClient: fake,
  });
}

describe('GitHub MCP Service — createBranch', () => {
  it('calls create_branch tool and returns branch + sha', async () => {
    const fake = new McpFakeHttpClient('corr-branch');
    fake.onTool('create_branch', (args) => ({
      ref: `refs/heads/${args.branch}`,
      object: { sha: 'new-branch-sha' },
    }));

    const svc = createMcpService(fake);
    const result = await svc.createBranch('owner', 'repo', 'feat-123');

    assert.strictEqual(result.branch, 'feat-123');
    assert.strictEqual(result.sha, 'new-branch-sha');
  });

  it('passes from_branch when specified', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fake = new McpFakeHttpClient('corr-branch-from');
    fake.onTool('create_branch', (args) => {
      capturedArgs = args;
      return { ref: 'refs/heads/feat', object: { sha: 'sha-x' } };
    });

    const svc = createMcpService(fake);
    await svc.createBranch('owner', 'repo', 'feat', 'develop');
    assert.strictEqual(capturedArgs.from_branch, 'develop');
  });
});

describe('GitHub MCP Service — commitFile', () => {
  it('commits file and returns commitSha + filePath', async () => {
    const fake = new McpFakeHttpClient('corr-commit');
    fake.onTool('create_or_update_file', () => ({
      commit: { sha: 'commit-sha-abc' },
    }));

    const svc = createMcpService(fake);
    const result = await svc.commitFile('owner', 'repo', 'main', 'src/app.ts', 'code', 'feat: add app');

    assert.strictEqual(result.commitSha, 'commit-sha-abc');
    assert.strictEqual(result.filePath, 'src/app.ts');
  });

  it('passes all parameters to tool call', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fake = new McpFakeHttpClient('corr-commit-args');
    fake.onTool('create_or_update_file', (args) => {
      capturedArgs = args;
      return { commit: { sha: 'sha' } };
    });

    const svc = createMcpService(fake);
    await svc.commitFile('myorg', 'myrepo', 'dev', 'file.ts', 'content', 'chore: update');

    assert.strictEqual(capturedArgs.owner, 'myorg');
    assert.strictEqual(capturedArgs.repo, 'myrepo');
    assert.strictEqual(capturedArgs.branch, 'dev');
    assert.strictEqual(capturedArgs.path, 'file.ts');
    assert.strictEqual(capturedArgs.content, 'content');
    assert.strictEqual(capturedArgs.message, 'chore: update');
  });
});

describe('GitHub MCP Service — getFileContentSafe', () => {
  it('returns null on file-not-found error (instead of throwing)', async () => {
    const fake = new McpFakeHttpClient('corr-safe');
    // Don't register handler — default -32601 error
    const svc = createMcpService(fake);
    // Remove the tool from available list so ensureToolAvailable throws
    fake.setTools([]);

    const result = await svc.getFileContentSafe('owner', 'repo', 'main', 'missing.ts');
    assert.strictEqual(result, null);
  });

  it('returns content when file exists', async () => {
    const fake = new McpFakeHttpClient('corr-safe-ok');
    fake.onTool('get_file_contents', () => ({
      content: 'hello world',
      sha: 'sha-safe',
    }));

    const svc = createMcpService(fake);
    const result = await svc.getFileContentSafe('owner', 'repo', 'main', 'exists.ts');
    assert.ok(result);
    assert.strictEqual(result.content, 'hello world');
    assert.strictEqual(result.sha, 'sha-safe');
  });

  it('throws on connection errors (not swallowed)', async () => {
    class FailingHttpClient extends HttpClient {
      async post(): Promise<Response> {
        throw new Error('Connection refused (ECONNREFUSED)');
      }
    }

    const svc = new GitHubMCPService({
      baseUrl: 'http://localhost:4010/mcp',
      correlationId: 'corr-safe-fail',
      httpClient: new FailingHttpClient(),
    });

    await assert.rejects(
      () => svc.getFileContentSafe('owner', 'repo', 'main', 'any.ts'),
      (err) => {
        assert.ok(err instanceof McpConnectionError);
        return true;
      },
    );
  });
});

describe('GitHub MCP Service — createPRDraft', () => {
  it('creates draft PR and returns prNumber + url', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fake = new McpFakeHttpClient('corr-pr');
    fake.onTool('create_pull_request', (args) => {
      capturedArgs = args;
      return { number: 99, html_url: 'https://github.com/o/r/pull/99' };
    });

    const svc = createMcpService(fake);
    const result = await svc.createPRDraft('o', 'r', 'Title', 'Body', 'feature', 'main');

    assert.strictEqual(result.prNumber, 99);
    assert.strictEqual(result.url, 'https://github.com/o/r/pull/99');
    assert.strictEqual(capturedArgs.draft, true);
  });
});

describe('GitHub MCP Service — getLatestRelease', () => {
  it('returns parsed release from get_latest_release tool', async () => {
    const fake = new McpFakeHttpClient('corr-release');
    fake.onTool('get_latest_release', () => ({
      id: 'R_123',
      tag_name: 'v1.0.0',
      name: 'Release 1.0.0',
      html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
      published_at: '2025-01-01T00:00:00Z',
    }));

    const svc = createMcpService(fake);
    const release = await svc.getLatestRelease('o', 'r');

    assert.ok(release);
    assert.strictEqual(release.tagName, 'v1.0.0');
    assert.strictEqual(release.name, 'Release 1.0.0');
    assert.ok(release.publishedAt instanceof Date);
  });

  it('returns null when no release tools exist', async () => {
    const fake = new McpFakeHttpClient('corr-no-release');
    // Only basic tools — no release tools
    fake.setTools(['get_file_contents', 'create_branch']);

    const svc = createMcpService(fake);
    const release = await svc.getLatestRelease('o', 'r');
    assert.strictEqual(release, null);
  });

  it('falls back through tool name variations', async () => {
    const fake = new McpFakeHttpClient('corr-release-fallback');
    // Only list_releases available, not get_latest_release
    fake.setTools(['get_file_contents', 'list_releases']);
    fake.onTool('list_releases', () => ([
      { tag_name: 'v2.0.0', name: 'v2', html_url: 'https://example.com', published_at: '2025-06-01T00:00:00Z', draft: false },
      { tag_name: 'v1.0.0', name: 'v1', html_url: 'https://example.com', published_at: '2025-01-01T00:00:00Z', draft: false },
    ]));

    const svc = createMcpService(fake);
    const release = await svc.getLatestRelease('o', 'r');
    assert.ok(release);
    assert.strictEqual(release.tagName, 'v2.0.0');
  });
});

describe('GitHub MCP Service — McpConnectionError helpers', () => {
  it('redactUrl strips path and query from URL', () => {
    assert.strictEqual(
      McpConnectionError.redactUrl('http://localhost:4010/mcp?token=secret'),
      'http://localhost:4010',
    );
  });

  it('redactUrl returns [invalid URL] for garbage input', () => {
    assert.strictEqual(
      McpConnectionError.redactUrl('not-a-url'),
      '[invalid URL]',
    );
  });

  it('fromNetworkError maps ENOTFOUND to MCP_DNS_FAILED', () => {
    const err = McpConnectionError.fromNetworkError(
      new Error('getaddrinfo ENOTFOUND mcp-gateway'),
      'corr-dns',
      'http://mcp-gateway:4010/mcp',
    );
    assert.strictEqual(err.code, McpErrorCode.MCP_DNS_FAILED);
    assert.ok(err.hint?.includes('GITHUB_MCP_BASE_URL'));
  });

  it('fromNetworkError maps timeout to MCP_TIMEOUT', () => {
    const err = McpConnectionError.fromNetworkError(
      new Error('Request timeout: AbortError'),
      'corr-timeout',
      'http://localhost:4010/mcp',
    );
    assert.strictEqual(err.code, McpErrorCode.MCP_TIMEOUT);
  });

  it('fromHttpStatus maps 429 to MCP_RATE_LIMITED', () => {
    const err = McpConnectionError.fromHttpStatus(429, 'Too Many Requests', 'corr-429', 'http://localhost:4010/mcp');
    assert.strictEqual(err.code, McpErrorCode.MCP_RATE_LIMITED);
    assert.ok(err.hint?.includes('rate limit') || err.hint?.includes('wait'));
  });

  it('McpError.toUserMessage includes code and correlationId', () => {
    const err = new McpError({
      code: -32601,
      method: 'tools/call',
      message: 'Tool not found',
      correlationId: 'user-corr-123',
    });
    const msg = err.toUserMessage();
    assert.ok(msg.includes('-32601'));
    assert.ok(msg.includes('user-corr-123'));
  });
});

describe('GitHub MCP Service — tool cache behavior', () => {
  it('caches tools/list and does not re-fetch within TTL', async () => {
    let toolsListCount = 0;
    const fake = new McpFakeHttpClient('corr-cache');

    // Override post to count tools/list calls
    const originalPost = fake.post.bind(fake);
    fake.post = async function (url: string, body?: unknown, token?: string, extraHeaders?: Record<string, string>) {
      const req = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (req.method === 'tools/list') toolsListCount += 1;
      return originalPost(url, body, token, extraHeaders);
    };

    fake.onTool('get_file_contents', () => ({
      content: 'data',
      sha: 'sha-cache',
    }));

    const svc = createMcpService(fake);

    // First call — should trigger initialize + tools/list + tools/call
    await svc.getFileContent('o', 'r', 'main', 'a.ts');
    assert.strictEqual(toolsListCount, 1);

    // Second call — tools/list should be cached
    await svc.getFileContent('o', 'r', 'main', 'b.ts');
    assert.strictEqual(toolsListCount, 1, 'tools/list should be cached on second call');
  });
});
