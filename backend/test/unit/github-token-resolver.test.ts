/**
 * Unit tests for the unified GitHub token resolver.
 * Covers priority order: oauth_accounts → legacy users.githubToken → dev_bootstrap → env fallback.
 * See issue #381 / BUG-01 (prod smoke 2026-04-17).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGitHubToken,
  getGitHubToken,
  type GitHubTokenDeps,
} from '../../src/services/auth/githubToken.js';

// Placeholder must match AgentOrchestrator.DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER exactly
// or the resolver's equality check won't trip the bootstrap branch.
const DEV_BOOTSTRAP_PLACEHOLDER = '__DEV_GITHUB_BOOTSTRAP__';

function makeDeps(overrides: Partial<GitHubTokenDeps> = {}): GitHubTokenDeps {
  return {
    readOauthRow: async () => null,
    readLegacyRow: async () => null,
    decrypt: () => null,
    readEnv: () => ({}),
    ...overrides,
  };
}

describe('resolveGitHubToken', () => {
  it('returns oauth_accounts source when OAuth token decrypts successfully', async () => {
    const deps = makeDeps({
      readOauthRow: async () => ({ accessToken: 'encrypted-blob' }),
      decrypt: () => 'gho_decrypted',
    });
    const result = await resolveGitHubToken('user-1', deps);
    assert.equal(result.source, 'oauth_accounts');
    assert.equal(result.token, 'gho_decrypted');
  });

  it('falls back to legacy column when OAuth row is missing', async () => {
    const deps = makeDeps({
      readOauthRow: async () => null,
      readLegacyRow: async () => ({ githubToken: 'ghp_legacy_pat' }),
    });
    const result = await resolveGitHubToken('user-2', deps);
    assert.equal(result.source, 'legacy_users_column');
    assert.equal(result.token, 'ghp_legacy_pat');
  });

  it('falls back to legacy column when OAuth decrypt throws', async () => {
    const deps = makeDeps({
      readOauthRow: async () => ({ accessToken: 'corrupt-blob' }),
      decrypt: () => {
        throw new Error('OAUTH_TOKEN_DECRYPT_FAILED');
      },
      readLegacyRow: async () => ({ githubToken: 'ghp_legacy_fallback' }),
    });
    const result = await resolveGitHubToken('user-3', deps);
    assert.equal(result.source, 'legacy_users_column');
    assert.equal(result.token, 'ghp_legacy_fallback');
  });

  it('expands dev bootstrap placeholder to env when flag set', async () => {
    const deps = makeDeps({
      readOauthRow: async () => ({ accessToken: DEV_BOOTSTRAP_PLACEHOLDER }),
      readEnv: () => ({
        SCRIBE_DEV_GITHUB_BOOTSTRAP: 'true',
        SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN: 'gho_bootstrap_secret',
      }),
    });
    const result = await resolveGitHubToken('user-4', deps);
    assert.equal(result.source, 'dev_bootstrap');
    assert.equal(result.token, 'gho_bootstrap_secret');
  });

  it('ignores bootstrap placeholder when SCRIBE_DEV_GITHUB_BOOTSTRAP is not true', async () => {
    const deps = makeDeps({
      readOauthRow: async () => ({ accessToken: DEV_BOOTSTRAP_PLACEHOLDER }),
      readEnv: () => ({}),
      readLegacyRow: async () => ({ githubToken: 'ghp_legacy' }),
    });
    const result = await resolveGitHubToken('user-5', deps);
    assert.equal(result.source, 'legacy_users_column');
    assert.equal(result.token, 'ghp_legacy');
  });

  it('uses DEV_MODE env fallback when both OAuth and legacy are empty', async () => {
    const deps = makeDeps({
      readOauthRow: async () => null,
      readLegacyRow: async () => ({ githubToken: null }),
      readEnv: () => ({
        DEV_MODE: 'true',
        GITHUB_TOKEN: 'ghp_env_fallback_token_longer_than_ten',
      }),
    });
    const result = await resolveGitHubToken('user-6', deps);
    assert.equal(result.source, 'dev_env_fallback');
    assert.equal(result.token, 'ghp_env_fallback_token_longer_than_ten');
  });

  it('rejects env fallback placeholder-style values', async () => {
    const deps = makeDeps({
      readEnv: () => ({
        DEV_MODE: 'true',
        GITHUB_TOKEN: '<replace-me>',
      }),
    });
    const result = await resolveGitHubToken('user-7', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('rejects env fallback when not in DEV_MODE', async () => {
    const deps = makeDeps({
      readEnv: () => ({
        DEV_MODE: 'false',
        GITHUB_TOKEN: 'ghp_would_work_but_prod',
      }),
    });
    const result = await resolveGitHubToken('user-8', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('returns {null, none} when all layers miss', async () => {
    const deps = makeDeps();
    const result = await resolveGitHubToken('user-9', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('survives OAuth lookup throwing by falling through to legacy', async () => {
    const deps = makeDeps({
      readOauthRow: async () => {
        throw new Error('DB connection failed');
      },
      readLegacyRow: async () => ({ githubToken: 'ghp_legacy_after_throw' }),
    });
    const result = await resolveGitHubToken('user-10', deps);
    assert.equal(result.source, 'legacy_users_column');
    assert.equal(result.token, 'ghp_legacy_after_throw');
  });
});

describe('getGitHubToken (thin wrapper)', () => {
  it('returns just the token string', async () => {
    const deps = makeDeps({
      readLegacyRow: async () => ({ githubToken: 'ghp_wrapper_test' }),
    });
    const token = await getGitHubToken('user-wrapper', deps);
    assert.equal(token, 'ghp_wrapper_test');
  });

  it('returns null when resolver finds nothing', async () => {
    const token = await getGitHubToken('user-nothing', makeDeps());
    assert.equal(token, null);
  });
});

// NOTE: A dynamic-import-based architectural invariant test previously lived
// here. It asserted that `src/api/github.ts` re-exports the same
// `getGitHubToken` identity as `services/auth/githubToken.ts`. That test passes
// locally (with DATABASE_URL set) but crashes in CI: importing the routes
// module eagerly resolves `getEnv()` which throws when DATABASE_URL is unset
// (the CI unit job has no DB). The same invariant is enforced by a grep check
// in CI (see .github/workflows — any file under backend/src/api/ that defines
// its own `getGitHubToken` should be flagged in review). Unit-testing it would
// require standing up a DB, which is out of scope for this suite.
