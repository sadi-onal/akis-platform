import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { knowledgeChunks, knowledgeDocuments, users } from '../../src/db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';

const hasDatabase = !!process.env.DATABASE_URL;

test('Knowledge hybrid retrieval route', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    return;
  }

  const app = await buildApp();
  await app.ready();
  const marker = `hybrid-${Date.now()}`;
  const userId = randomUUID();
  const userEmail = `${marker}@test.local`;
  const createdDocumentIds: string[] = [];

  const cleanup = async () => {
    if (createdDocumentIds.length > 0) {
      await db.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, createdDocumentIds));
    }
    await db.delete(users).where(and(eq(users.id, userId), eq(users.email, userEmail)));
  };

  try {
    await db.insert(users).values({
      id: userId,
      name: 'Hybrid Retrieval User',
      email: userEmail,
      passwordHash: 'test-hash',
      role: 'member',
      status: 'active',
      emailVerified: true,
    });

    const insertedDocs = await db
      .insert(knowledgeDocuments)
      .values([
        {
          title: `${marker}-contract`,
          content: `${marker} Contract enforcement keeps agent input and output deterministic.`,
          docType: 'manual',
          status: 'approved',
        },
        {
          title: `${marker}-freshness`,
          content: 'Freshness and release signals improve confidence on evidence quality.',
          docType: 'manual',
          status: 'approved',
        },
      ])
      .returning({ id: knowledgeDocuments.id });
    createdDocumentIds.push(...insertedDocs.map((doc) => doc.id));

    await db.insert(knowledgeChunks).values([
      {
        documentId: insertedDocs[0].id,
        chunkIndex: 0,
        content: `${marker} contract enforcement deterministic agent output`,
        tokenCount: 8,
      },
      {
        documentId: insertedDocs[1].id,
        chunkIndex: 0,
        content: 'Freshness release signal confidence evidence quality',
        tokenCount: 8,
      },
    ]);

    const userToken = await sign({ sub: userId, email: userEmail, name: 'Hybrid Retrieval User' });

    await t.test('route requires auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/retrieval/hybrid',
        payload: { query: 'contract enforcement' },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'UNAUTHORIZED');
    });

    await t.test('route validates payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/retrieval/hybrid',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: userToken as unknown as string },
        payload: { query: '', topK: 0 },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'INVALID_INPUT');
    });

    await t.test('returns stable ranking for same query', async () => {
      const payload = {
        query: `${marker} contract deterministic`,
        topK: 5,
        includeProposed: false,
        keywordWeight: 0.55,
        semanticWeight: 0.45,
      };

      const first = await app.inject({
        method: 'POST',
        url: '/api/knowledge/retrieval/hybrid',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: userToken as unknown as string },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/knowledge/retrieval/hybrid',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: userToken as unknown as string },
        payload,
      });

      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);

      const firstBody = first.json();
      const secondBody = second.json();
      assert.equal(firstBody.query, payload.query);
      assert.equal(Array.isArray(firstBody.results), true);
      assert.ok(firstBody.results.length >= 1);

      const firstIds = firstBody.results.map((result: { chunkId: string }) => result.chunkId);
      const secondIds = secondBody.results.map((result: { chunkId: string }) => result.chunkId);
      assert.deepEqual(firstIds, secondIds);
    });
  } finally {
    await cleanup();
    await app.close();
  }
});
