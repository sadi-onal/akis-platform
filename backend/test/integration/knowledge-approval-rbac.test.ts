import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { knowledgeDocuments, users } from '../../src/db/schema.js';
import { and, eq, ilike, inArray } from 'drizzle-orm';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';

const hasDatabase = !!process.env.DATABASE_URL;

test('Knowledge approval workflow RBAC', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    return;
  }

  const app = await buildApp();
  await app.ready();
  const marker = `knowledge-rbac-${Date.now()}`;
  const adminId = randomUUID();
  const memberId = randomUUID();
  const adminEmail = `${marker}-admin@test.local`;
  const memberEmail = `${marker}-member@test.local`;
  let seededDocumentId = '';
  let uploadedDocumentId = '';

  const cleanup = async () => {
    const docs = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(ilike(knowledgeDocuments.title, `${marker}%`));

    if (docs.length > 0) {
      await db.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, docs.map((doc) => doc.id)));
    }
    await db.delete(users).where(and(eq(users.id, adminId), eq(users.email, adminEmail)));
    await db.delete(users).where(and(eq(users.id, memberId), eq(users.email, memberEmail)));
  };

  try {
    await db.insert(users).values([
      {
        id: adminId,
        name: 'Knowledge Admin',
        email: adminEmail,
        passwordHash: 'test-hash',
        role: 'admin',
        status: 'active',
        emailVerified: true,
      },
      {
        id: memberId,
        name: 'Knowledge Member',
        email: memberEmail,
        passwordHash: 'test-hash',
        role: 'member',
        status: 'active',
        emailVerified: true,
      },
    ]);

    const [seeded] = await db
      .insert(knowledgeDocuments)
      .values({
        title: `${marker}-seeded`,
        content: 'Seeded proposed document for RBAC test',
        docType: 'manual',
        status: 'proposed',
      })
      .returning({ id: knowledgeDocuments.id });
    seededDocumentId = seeded.id;

    const adminToken = await sign({ sub: adminId, email: adminEmail, name: 'Knowledge Admin' });
    const memberToken = await sign({ sub: memberId, email: memberEmail, name: 'Knowledge Member' });

    await t.test('documents list requires auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/knowledge/documents?status=proposed' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'UNAUTHORIZED');
    });

    await t.test('member cannot list governance documents', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge/documents?status=proposed',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: memberToken as unknown as string },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    });

    await t.test('admin can list proposed documents', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge/documents?status=proposed',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(Array.isArray(body.items), true);
      assert.equal(body.items.some((doc: { id: string }) => doc.id === seededDocumentId), true);
    });

    await t.test('member cannot approve document', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/knowledge/documents/${seededDocumentId}/approve`,
        cookies: { [authEnv.AUTH_COOKIE_NAME]: memberToken as unknown as string },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    });

    await t.test('admin can approve and deprecate document', async () => {
      const approve = await app.inject({
        method: 'POST',
        url: `/api/knowledge/documents/${seededDocumentId}/approve`,
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
      });
      assert.equal(approve.statusCode, 200);
      assert.equal(approve.json().document.status, 'approved');

      const deprecate = await app.inject({
        method: 'POST',
        url: `/api/knowledge/documents/${seededDocumentId}/deprecate`,
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
      });
      assert.equal(deprecate.statusCode, 200);
      assert.equal(deprecate.json().document.status, 'deprecated');
    });

    await t.test('upload validates payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/documents/upload',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
        payload: { title: '', content: '' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'INVALID_INPUT');
    });

    await t.test('admin can upload and index manual document', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/documents/upload',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
        payload: {
          title: `${marker}-upload`,
          content: 'AKIS reliability closure plan upload integration test content.',
          sourcePath: `/tmp/${marker}.md`,
          status: 'proposed',
        },
      });

      assert.equal(response.statusCode, 201);
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.result.chunksCreated, 'number');
      assert.ok(body.result.chunksCreated >= 1);
      uploadedDocumentId = body.result.documentId as string;
    });

    await t.test('uploaded document appears in proposed list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/knowledge/documents?status=proposed',
        cookies: { [authEnv.AUTH_COOKIE_NAME]: adminToken as unknown as string },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.items.some((doc: { id: string }) => doc.id === uploadedDocumentId), true);
    });
  } finally {
    await cleanup();
    await app.close();
  }
});
