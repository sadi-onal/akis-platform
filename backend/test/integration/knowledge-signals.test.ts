import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { knowledgeSources, users } from '../../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';

const hasDatabase = !!process.env.DATABASE_URL;

test('Knowledge signals routes', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    return;
  }

  const app = await buildApp();
  await app.ready();
  const adminId = randomUUID();
  const adminEmail = `knowledge-signals-admin-${Date.now()}@test.local`;
  const marker = `${Date.now()}`;
  let hasKnowledgeSourcesTable = true;

  try {
    await db.execute(sql`select 1 from knowledge_sources limit 1`);
  } catch {
    hasKnowledgeSourcesTable = false;
  }

  const cleanup = async () => {
    if (hasKnowledgeSourcesTable) {
      await db
        .delete(knowledgeSources)
        .where(eq(knowledgeSources.sourceUrl, `https://example.test/advisories/${marker}`));
    }
    await db.delete(users).where(eq(users.id, adminId));
  };

  try {
    await db.insert(users).values({
      id: adminId,
      name: 'Knowledge Signals Admin',
      email: adminEmail,
      passwordHash: 'test-hash',
      role: 'admin',
      status: 'active',
      emailVerified: true,
    });

    const adminToken = await sign({ sub: adminId, email: adminEmail, name: 'Knowledge Signals Admin' });

    await t.test('release sync requires auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/signals/releases/sync',
        payload: { owner: 'openai', repo: 'openai-node' },
      });

      assert.equal(response.statusCode, 401);
      const body = response.json();
      assert.equal(body.error.code, 'UNAUTHORIZED');
    });

    await t.test('release sync validates payload for admin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/signals/releases/sync',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
        payload: {},
      });

      assert.equal(response.statusCode, 400);
      const body = response.json();
      assert.equal(body.error.code, 'INVALID_INPUT');
    });

    await t.test('cve sync requires auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/signals/cve/sync',
        payload: {
          advisories: [
            {
              cveId: 'CVE-2026-1000',
              summary: 'test advisory',
              severity: 'high',
              sourceUrl: 'https://example.test/advisories/x',
            },
          ],
        },
      });

      assert.equal(response.statusCode, 401);
      const body = response.json();
      assert.equal(body.error.code, 'UNAUTHORIZED');
    });

    await t.test('cve sync validates payload for admin', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/signals/cve/sync',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
        payload: { advisories: [{ cveId: 'INVALID-CVE' }] },
      });

      assert.equal(response.statusCode, 400);
      const body = response.json();
      assert.equal(body.error.code, 'INVALID_INPUT');
    });

    await t.test('manual advisory sync works and returns deterministic summary', async () => {
      if (!hasKnowledgeSourcesTable) {
        t.skip('knowledge_sources table is not available in this test database');
        return;
      }

      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/signals/cve/sync',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
        payload: {
          advisories: [
            {
              cveId: `CVE-2026-${marker.slice(-4)}`,
              summary: 'Synthetic advisory for integration test',
              severity: 'medium',
              sourceUrl: `https://example.test/advisories/${marker}`,
            },
          ],
        },
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.summary.source, 'manual');
      assert.equal(typeof body.summary.inserted, 'number');
      assert.equal(typeof body.summary.updated, 'number');
      assert.equal(typeof body.summary.deduped, 'number');
    });
  } finally {
    await cleanup();
    await app.close();
  }
});
