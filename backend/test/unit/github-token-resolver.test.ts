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
  type GitHubTokenDeps,
} from '../../src/services/auth/githubToken.js';

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
