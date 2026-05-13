// Env-schema gate for DOGFOOD_MODE. Locks in two contracts that the
// review of PR #537 surfaced:
//   1. Default behavior: flag absent or `'false'` → `getEnv().DOGFOOD_MODE`
//      is the boolean `false` (NOT the string).
//   2. Production guard: `NODE_ENV=production` + `DOGFOOD_MODE=true` is
//      rejected at boot so a leaked dev flag can't disable GitHub
//      validation in a real deployment.
//
// Both call sites (PipelineOrchestrator.validateGitHubAccess + the
// /api/integrations/github/status route) now read `getEnv().DOGFOOD_MODE`,
// so this schema test transitively covers them.
//
// Each test sets a full fake env (incl. DATABASE_URL) because CI does not
// provide one and a fresh `__clearEnvCacheForTests()` + `getEnv()` re-parses
// `process.env` from scratch.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __clearEnvCacheForTests, getEnv } from '../../src/config/env.js';

const REQUIRED_KEYS = [
  'NODE_ENV',
  'DOGFOOD_MODE',
  'DATABASE_URL',
  'AUTH_COOKIE_SECURE',
  'AUTH_JWT_SECRET',
] as const;

function snapshotKeys() {
  const snap: Record<string, string | undefined> = {};
  for (const k of REQUIRED_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreKeys(snap: Record<string, string | undefined>) {
  for (const k of REQUIRED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function applyDevEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.AUTH_JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
  delete process.env.AUTH_COOKIE_SECURE;
  delete process.env.DOGFOOD_MODE;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function applyProdEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://prod:prod@localhost:5432/prod';
  process.env.AUTH_COOKIE_SECURE = 'true';
  process.env.AUTH_JWT_SECRET = 'production-jwt-secret-at-least-32-chars-long';
  delete process.env.DOGFOOD_MODE;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('DOGFOOD_MODE env schema', () => {
  let saved: ReturnType<typeof snapshotKeys>;

  beforeEach(() => {
    saved = snapshotKeys();
    __clearEnvCacheForTests();
  });

  afterEach(() => {
    restoreKeys(saved);
    __clearEnvCacheForTests();
  });

  it('defaults DOGFOOD_MODE to the boolean false when the env var is unset', () => {
    applyDevEnv();
    __clearEnvCacheForTests();
    const env = getEnv();
    assert.equal(env.DOGFOOD_MODE, false);
  });

  it('parses DOGFOOD_MODE=true in development as the boolean true', () => {
    applyDevEnv({ DOGFOOD_MODE: 'true' });
    __clearEnvCacheForTests();
    const env = getEnv();
    assert.equal(env.DOGFOOD_MODE, true);
  });

  it('rejects DOGFOOD_MODE=true when NODE_ENV=production', () => {
    applyProdEnv({ DOGFOOD_MODE: 'true' });
    __clearEnvCacheForTests();
    assert.throws(
      () => getEnv(),
      (err: Error) => err.message.toLowerCase().includes('dogfood_mode')
    );
  });

  it('accepts DOGFOOD_MODE=false in production (no false positives)', () => {
    applyProdEnv({ DOGFOOD_MODE: 'false' });
    __clearEnvCacheForTests();
    const env = getEnv();
    assert.equal(env.DOGFOOD_MODE, false);
  });
});
