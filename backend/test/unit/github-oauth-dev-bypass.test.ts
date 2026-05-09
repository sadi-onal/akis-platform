/**
 * Unit tests for the DEV_MODE GitHub OAuth bypass decision.
 *
 * Pure-function tests — no app boot, no DB, no network. Verifies that the
 * bypass only triggers in safe dev contexts and chooses the right fallback
 * token to write into github_integrations.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGithubOAuthDevBypass,
  DEV_BYPASS_SENTINEL_TOKEN,
} from '../../src/services/auth/githubOauthDevBypass.js';

describe('evaluateGithubOAuthDevBypass', () => {
  test('production never bypasses, even with placeholders', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'production',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
      GITHUB_OAUTH_CLIENT_SECRET: '<placeholder>',
      GITHUB_TOKEN: 'ghp_real_looking_token_12345',
    });
    assert.equal(decision.bypassEnabled, false);
    assert.equal(decision.reason, 'production');
  });

  test('DEV_MODE off → no bypass', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'false',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
    });
    assert.equal(decision.bypassEnabled, false);
    assert.equal(decision.reason, 'dev_mode_off');
  });

  test('OAuth fully configured → no bypass', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.realclientid',
      GITHUB_OAUTH_CLIENT_SECRET: 'realclientsecret123',
      GITHUB_TOKEN: 'ghp_real_token_12345',
    });
    assert.equal(decision.bypassEnabled, false);
    assert.equal(decision.reason, 'oauth_configured');
  });

  test('placeholder client id + real token → bypass with real token', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<from GitHub Developer Settings>',
      GITHUB_OAUTH_CLIENT_SECRET: '<from same>',
      GITHUB_TOKEN: 'ghp_real_looking_token_with_enough_length',
    });
    assert.equal(decision.bypassEnabled, true);
    assert.equal(decision.reason, 'bypass_active');
    assert.equal(decision.tokenIsReal, true);
    assert.equal(decision.fallbackToken, 'ghp_real_looking_token_with_enough_length');
  });

  test('placeholder OAuth + dummy GITHUB_TOKEN → sentinel fallback', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
      GITHUB_OAUTH_CLIENT_SECRET: '<placeholder>',
      GITHUB_TOKEN: 'ghp_dummy_skip_for_smoke',
    });
    assert.equal(decision.bypassEnabled, true);
    assert.equal(decision.tokenIsReal, false);
    assert.equal(decision.fallbackToken, DEV_BYPASS_SENTINEL_TOKEN);
  });

  test('placeholder OAuth + missing GITHUB_TOKEN → sentinel fallback', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
      GITHUB_OAUTH_CLIENT_SECRET: '<placeholder>',
      GITHUB_TOKEN: undefined,
    });
    assert.equal(decision.bypassEnabled, true);
    assert.equal(decision.tokenIsReal, false);
    assert.equal(decision.fallbackToken, DEV_BYPASS_SENTINEL_TOKEN);
  });

  test('only client id missing → bypass triggers (partial config also unusable)', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
      GITHUB_OAUTH_CLIENT_SECRET: 'realsecret123',
      GITHUB_TOKEN: 'ghp_real_token_12345',
    });
    assert.equal(decision.bypassEnabled, true);
  });

  test('GITHUB_TOKEN under length threshold → sentinel', () => {
    const decision = evaluateGithubOAuthDevBypass({
      DEV_MODE: 'true',
      NODE_ENV: 'development',
      GITHUB_OAUTH_CLIENT_ID: '<placeholder>',
      GITHUB_OAUTH_CLIENT_SECRET: '<placeholder>',
      GITHUB_TOKEN: 'short',
    });
    assert.equal(decision.bypassEnabled, true);
    assert.equal(decision.tokenIsReal, false);
    assert.equal(decision.fallbackToken, DEV_BYPASS_SENTINEL_TOKEN);
  });
});
