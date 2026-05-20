/**
 * Unit tests for the unified GitHub token resolver.
 *
 * The resolver now reads exclusively from the dedicated `github_integrations`
 * table — login (`oauth_accounts`) and integration tokens are stored in
 * separate tables, and the legacy `users.github_token` column has been dropped.
 * The DEV_MODE env fallback is the only secondary path (and only outside prod).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGitHubToken,
  getGitHubToken,
  invalidateUserGitHubToken,
  type GitHubTokenDeps,
} from '../../src/services/auth/githubToken.js';
import { DEV_BYPASS_SENTINEL_TOKEN } from '../../src/services/auth/githubOauthDevBypass.js';

function makeDeps(overrides: Partial<GitHubTokenDeps> = {}): GitHubTokenDeps {
  return {
    readIntegrationRow: async () => null,
    decrypt: () => null,
    readEnv: () => ({}),
    ...overrides,
  };
}

describe('resolveGitHubToken', () => {
  it('returns github_integrations source when integration token decrypts', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => ({ accessToken: 'encrypted-blob' }),
      decrypt: () => 'gho_decrypted',
    });
    const result = await resolveGitHubToken('user-1', deps);
    assert.equal(result.source, 'github_integrations');
    assert.equal(result.token, 'gho_decrypted');
  });

  it('returns none when integration row missing and no dev fallback', async () => {
    const result = await resolveGitHubToken('user-2', makeDeps());
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('returns none when decrypt throws and no dev fallback', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => ({ accessToken: 'corrupt-blob' }),
      decrypt: () => {
        throw new Error('OAUTH_TOKEN_DECRYPT_FAILED');
      },
    });
    const result = await resolveGitHubToken('user-3', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('falls through to dev env fallback when integration table empty', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => null,
      readEnv: () => ({
        DEV_MODE: 'true',
        GITHUB_TOKEN: 'ghp_env_fallback_token_longer_than_ten',
      }),
    });
    const result = await resolveGitHubToken('user-4', deps);
    assert.equal(result.source, 'dev_env_fallback');
    assert.equal(result.token, 'ghp_env_fallback_token_longer_than_ten');
  });

  it('rejects placeholder-style env values', async () => {
    const deps = makeDeps({
      readEnv: () => ({
        DEV_MODE: 'true',
        GITHUB_TOKEN: '<replace-me>',
      }),
    });
    const result = await resolveGitHubToken('user-5', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('does not use env fallback outside DEV_MODE', async () => {
    const deps = makeDeps({
      readEnv: () => ({
        DEV_MODE: 'false',
        GITHUB_TOKEN: 'ghp_would_work_but_prod',
      }),
    });
    const result = await resolveGitHubToken('user-6', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('treats dev-bypass sentinel as no token (so pipeline fails fast)', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => ({ accessToken: 'encrypted-sentinel' }),
      decrypt: () => DEV_BYPASS_SENTINEL_TOKEN,
    });
    const result = await resolveGitHubToken('user-sentinel', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });

  it('survives integration lookup throwing', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => {
        throw new Error('DB connection failed');
      },
    });
    const result = await resolveGitHubToken('user-7', deps);
    assert.equal(result.source, 'none');
    assert.equal(result.token, null);
  });
});

describe('getGitHubToken (thin wrapper)', () => {
  it('returns just the token string', async () => {
    const deps = makeDeps({
      readIntegrationRow: async () => ({ accessToken: 'encrypted-blob' }),
      decrypt: () => 'gho_wrapper_test',
    });
    const token = await getGitHubToken('user-wrapper', deps);
    assert.equal(token, 'gho_wrapper_test');
  });

  it('returns null when resolver finds nothing', async () => {
    const token = await getGitHubToken('user-nothing', makeDeps());
    assert.equal(token, null);
  });
});

// PR-V-github-401-graceful — when GitHub returns 401, the orchestrator drops
// the stale row from `github_integrations` so the next pipeline starts from a
// clean state instead of retrying the dead credential indefinitely.
describe('invalidateUserGitHubToken', () => {
  it('returns true when a row was deleted', async () => {
    let deleteCalledWith: string | null = null;
    const result = await invalidateUserGitHubToken('user-revoked', {
      deleteIntegrationRow: async (userId) => {
        deleteCalledWith = userId;
        return { rowCount: 1 };
      },
    });
    assert.equal(result, true);
    assert.equal(deleteCalledWith, 'user-revoked');
  });

  it('returns false when no row existed (idempotent)', async () => {
    const result = await invalidateUserGitHubToken('user-never-connected', {
      deleteIntegrationRow: async () => ({ rowCount: 0 }),
    });
    assert.equal(result, false);
  });

  it('swallows DB errors and returns false (does not rethrow)', async () => {
    const result = await invalidateUserGitHubToken('user-db-down', {
      deleteIntegrationRow: async () => {
        throw new Error('connection refused');
      },
    });
    assert.equal(result, false);
  });
});
