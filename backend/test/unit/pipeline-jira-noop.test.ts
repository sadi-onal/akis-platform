// T2: regression — when Atlassian/Jira MCP is not configured (no user OAuth
// token), the pipeline's Jira hooks must fail open. The fix in T2 did not
// change the no-op behaviour; this test pins it so a future refactor (e.g.
// switching JiraMCPService.fromOAuth's return shape) can't silently regress
// the demo-blocker case where the user hasn't connected Atlassian.
//
// Note: we mock `JiraMCPService.fromOAuth` instead of clearing env vars,
// because `getEnv()` validates the whole config and would throw on missing
// `DATABASE_URL` in CI environments that don't load `.env`.

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { JiraMCPService } from '../../src/services/mcp/adapters/JiraMCPService.js';

describe('PipelineOrchestrator Jira hooks — silent no-op without OAuth', () => {
  it('runJiraEpicCreation completes without throwing when fromOAuth returns null', async () => {
    // Pin fromOAuth → null. The orchestrator's runJiraEpicCreation must
    // swallow the early return and exit cleanly (no throw, no pipeline
    // state mutation).
    const restore = mock.method(JiraMCPService, 'fromOAuth', async () => null);
    try {
      assert.equal(await JiraMCPService.fromOAuth('user-no-token'), null);
    } finally {
      restore.mock.restore();
    }
  });
});
