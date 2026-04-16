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

test('RAG evaluation run endpoint', { skip: !hasDatabase }, async () => {
  if (!hasDatabase) {
    return;
  }

  const app = await buildApp();
  await app.ready();

  const marker = `rag-eval-${Date.now()}`;
  const userId = randomUUID();
  const email = `${marker}@test.local`;
  const documentIds: string[] = [];

  const cleanup = async () => {
    if (documentIds.length > 0) {
      await db.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, documentIds));
    }
    await db.delete(users).where(and(eq(users.id, userId), eq(users.email, email)));
  };

  try {
    await db.insert(users).values({
      id: userId,
      name: 'RAG Eval User',
      email,
      passwordHash: 'test-hash',
      role: 'member',
      status: 'active',
      emailVerified: true,
    });

    const docs = await db
      .insert(knowledgeDocuments)
      .values([
        {
          title: `${marker}-contract`,
          content: 'Contract enforcement and deterministic behavior improve trust.',
          docType: 'manual',
          status: 'approved',
          metadata: { freshness: { score: 0.9 } },
        },
        {
          title: `${marker}-freshness`,
          content: 'Freshness scoring uses release recency and source update recency.',
          docType: 'manual',
          status: 'approved',
          metadata: { freshness: { score: 0.8 } },
        },
      ])
      .returning({ id: knowledgeDocuments.id });
    documentIds.push(...docs.map((doc) => doc.id));

    await db.insert(knowledgeChunks).values([
      {
        documentId: docs[0].id,
        chunkIndex: 0,
        content: 'Contract enforcement deterministic behavior trust',
        tokenCount: 8,
      },
      {
        documentId: docs[1].id,
        chunkIndex: 0,
        content: 'Freshness score release recency source updates',
        tokenCount: 8,
      },
    ]);

    const token = await sign({ sub: userId, email, name: 'RAG Eval User' });
    const cookies = { [authEnv.AUTH_COOKIE_NAME]: token };

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/rag/evaluation/run',
      cookies,
      payload: { queries: [] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_INPUT');

    const response = await app.inject({
      method: 'POST',
      url: '/api/rag/evaluation/run',
      cookies,
      payload: {
        queries: ['contract enforcement', 'freshness release'],
        topK: 5,
        maxTokens: 4000,
        minResultsThreshold: 1,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.runId, 'string');
    assert.equal(typeof body.executedAt, 'string');
    assert.equal(typeof body.metrics.relevance, 'number');
    assert.equal(typeof body.metrics.coverage, 'number');
    assert.equal(typeof body.metrics.freshness, 'number');
    assert.equal(typeof body.metrics.provenance, 'number');
    assert.equal(typeof body.metrics.stability, 'number');
    assert.equal(Array.isArray(body.queries), true);
    assert.equal(body.queries.length, 2);
  } finally {
    await cleanup();
    await app.close();
  }
});
