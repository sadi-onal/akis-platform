/**
 * Unit tests for GET /api/ai/supported-models — P12.
 *
 * Coverage:
 *  - 'google' query param now accepted (P12 widened the enum).
 *  - 'openai' still returns DEFAULT_OPENAI_MODELS (P1a wired the runtime).
 *  - Unknown providers fall back to the default (anthropic).
 *
 * The route runs through Fastify's `inject` against a standalone instance
 * (no DB / no auth) — `requireAuth` is the only DB-touching helper and it
 * is short-circuited by the lack of cookies (catch in the handler).
 */
// Set CI-required env vars BEFORE any module imports — the route's import
// chain reaches env.ts:getEnv() which fails fast on missing DATABASE_URL /
// AUTH_JWT_SECRET. CI does not provide them for unit tests.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.AUTH_JWT_SECRET ??= 'a'.repeat(32);

import { describe, it } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { aiModelsRoutes } from '../../src/api/ai-models.js';
import { DEFAULT_GOOGLE_MODELS, DEFAULT_OPENAI_MODELS } from '../../src/services/ai/modelAllowlist.js';

async function makeApp() {
  const app = Fastify({ logger: false });
  await app.register(aiModelsRoutes);
  await app.ready();
  return app;
}

describe('GET /api/ai/supported-models — provider=google (P12)', () => {
  it('accepts provider=google and returns DEFAULT_GOOGLE_MODELS', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/supported-models?provider=google',
      });

      assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload}`);
      const body = JSON.parse(res.payload) as {
        provider: string;
        models: Array<{ id: string; provider: string; recommended: boolean }>;
      };
      assert.strictEqual(body.provider, 'google');
      assert.ok(body.models.length > 0, 'expected non-empty models array');
      const ids = body.models.map((m) => m.id);
      for (const expected of DEFAULT_GOOGLE_MODELS) {
        assert.ok(ids.includes(expected), `missing ${expected} in google response`);
      }
      // Every returned model carries provider='google'.
      assert.ok(body.models.every((m) => m.provider === 'google'));
    } finally {
      await app.close();
    }
  });

  it('still returns DEFAULT_OPENAI_MODELS for provider=openai (P1a)', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/supported-models?provider=openai',
      });
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { provider: string; models: Array<{ id: string }> };
      assert.strictEqual(body.provider, 'openai');
      const ids = body.models.map((m) => m.id);
      for (const expected of DEFAULT_OPENAI_MODELS) {
        assert.ok(ids.includes(expected), `missing ${expected} in openai response`);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown provider value via JSON schema enum (400)', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/supported-models?provider=mistral',
      });
      // Fastify ajv rejects with 400 BAD_REQUEST when the enum constraint fails.
      assert.strictEqual(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
