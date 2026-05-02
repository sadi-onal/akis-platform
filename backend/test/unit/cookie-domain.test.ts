/**
 * AUTH_COOKIE_DOMAIN — cookie issuance regression test
 *
 * Guards the prod cookie domain config: the live `Set-Cookie` header MUST
 * carry `Domain=akisflow.com` when `AUTH_COOKIE_DOMAIN=akisflow.com` is set,
 * otherwise the OAuth callback redirect chain on `akisflow.com` (and any
 * www↔apex hop) drops the session cookie and the user gets bounced to
 * /login. See docs/ops/AUTH_LOOP_DIAGNOSIS_2026-05-02.md.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN;
const ORIGINAL_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE;
const ORIGINAL_COOKIE_NAME = process.env.AUTH_COOKIE_NAME;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_JWT = process.env.AUTH_JWT_SECRET;

async function loadCookieOpts(domain: string | undefined) {
  // env.ts validates DATABASE_URL on first load; provide a placeholder so
  // the import doesn't throw in this isolated test.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  }
  if (!process.env.AUTH_JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'test-jwt-secret-minimum-32-chars!!';
  }
  process.env.AUTH_COOKIE_SECURE = 'true';
  process.env.AUTH_COOKIE_NAME = 'akis_session';
  if (domain === undefined) {
    delete process.env.AUTH_COOKIE_DOMAIN;
  } else {
    process.env.AUTH_COOKIE_DOMAIN = domain;
  }

  // Bust the env-cache (lib/env.ts caches at module-init via getEnv())
  const configMod = await import('../../src/config/env.js');
  configMod.__clearEnvCacheForTests();

  // Re-import lib/env.ts with a unique query string so the module factory
  // re-runs against the fresh process.env. Without the query string Node's
  // ESM loader hands back the cached module and the test is a no-op.
  const fresh = await import(`../../src/lib/env.ts?cookie-domain-test=${Date.now()}-${Math.random()}`);
  return fresh.cookieOpts as { domain?: string; secure: boolean; sameSite: string };
}

describe('AUTH_COOKIE_DOMAIN — cookie attribute regression', () => {
  after(() => {
    // Restore original env so other tests aren't poisoned.
    if (ORIGINAL_COOKIE_DOMAIN === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
    else process.env.AUTH_COOKIE_DOMAIN = ORIGINAL_COOKIE_DOMAIN;
    if (ORIGINAL_COOKIE_SECURE === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = ORIGINAL_COOKIE_SECURE;
    if (ORIGINAL_COOKIE_NAME === undefined) delete process.env.AUTH_COOKIE_NAME;
    else process.env.AUTH_COOKIE_NAME = ORIGINAL_COOKIE_NAME;
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_JWT === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = ORIGINAL_JWT;
  });

  it('sets cookieOpts.domain when AUTH_COOKIE_DOMAIN=akisflow.com', async () => {
    const opts = await loadCookieOpts('akisflow.com');
    assert.equal(opts.domain, 'akisflow.com', 'cookieOpts.domain must reflect the env var');
    assert.equal(opts.secure, true);
    assert.equal(opts.sameSite, 'none', 'secure=true must force sameSite=none for cross-site OAuth redirects');
  });

  it('omits cookieOpts.domain when AUTH_COOKIE_DOMAIN is unset (host-only cookie)', async () => {
    const opts = await loadCookieOpts(undefined);
    assert.equal(opts.domain, undefined, 'unset env must not introduce a Domain attribute');
  });

  it('omits cookieOpts.domain when AUTH_COOKIE_DOMAIN is empty string', async () => {
    const opts = await loadCookieOpts('');
    assert.equal(opts.domain, undefined, 'empty env must not introduce a Domain attribute');
  });
});
