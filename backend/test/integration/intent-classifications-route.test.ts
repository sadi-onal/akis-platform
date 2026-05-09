/**
 * Integration test for the chat-intent route (FR-11).
 *
 * Exercises:
 *  - POST /api/chat/intent  — auth required + persists a classification row
 *  - PATCH /api/chat/intent/:id — sets `override_intent` for the row
 *  - 401 unauthenticated; 400 on bad body
 *
 * Uses the running Postgres (DATABASE_URL); skips cleanly otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { users, intentClassifications } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../src/services/auth/password.js';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';

const hasDatabase = !!process.env.DATABASE_URL;

test('Chat intent route (FR-11)', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    console.log('Skipping: DATABASE_URL not set');
    return;
  }

  const app = await buildApp();
  const userId = randomUUID();
  const userEmail = `intent-route-${Date.now()}@test.local`;
  const password = 'test-password-123';

  const cleanup = async () => {
    try {
      await db.delete(intentClassifications).where(eq(intentClassifications.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  };

  await t.test('Setup: create active user', async () => {
    const hash = await hashPassword(password);
    await db.insert(users).values({
      id: userId,
      name: 'Intent Tester',
      email: userEmail,
      passwordHash: hash,
      emailVerified: true,
      status: 'active',
    });
  });

  const jwt = await sign({ sub: userId, email: userEmail, name: 'Intent Tester' });
  const cookie = `${authEnv.AUTH_COOKIE_NAME}=${jwt}`;

  await t.test('POST /api/chat/intent — 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/intent',
      payload: { message: 'add a button' },
    });
    assert.strictEqual(response.statusCode, 401);
  });

  await t.test('POST /api/chat/intent — 400 when message missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/intent',
      headers: { cookie },
      payload: {},
    });
    assert.strictEqual(response.statusCode, 400);
  });

  let classificationId = '';

  await t.test('POST /api/chat/intent — classifies + persists row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/intent',
      headers: { cookie },
      payload: { message: 'borç takibi sayfası ekle' },
    });
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(['BUILD', 'ASK', 'FEEDBACK', 'CHAT'].includes(body.intent));
    assert.strictEqual(typeof body.confidence, 'number');
    assert.strictEqual(typeof body.threshold, 'number');
    assert.ok(body.classificationId, 'response must include classificationId');
    classificationId = body.classificationId;

    // DB row exists, hashed not raw.
    const rows = await db
      .select()
      .from(intentClassifications)
      .where(eq(intentClassifications.userId, userId));
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.intent, body.intent);
    assert.match(row.messageHash, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(row.messageHash, 'borç takibi sayfası ekle');
    assert.strictEqual(row.overrideIntent, null);
  });

  await t.test('PATCH /api/chat/intent/:id — applies override', async () => {
    assert.ok(classificationId, 'POST must run first');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/chat/intent/${classificationId}`,
      headers: { cookie },
      payload: { overrideIntent: 'ASK' },
    });
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.ok, true);

    const rows = await db
      .select()
      .from(intentClassifications)
      .where(eq(intentClassifications.id, BigInt(classificationId)));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].overrideIntent, 'ASK');
  });

  await t.test('PATCH /api/chat/intent/:id — 400 on bad intent', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/chat/intent/${classificationId}`,
      headers: { cookie },
      payload: { overrideIntent: 'NOPE' },
    });
    assert.strictEqual(response.statusCode, 400);
  });

  await t.test('PATCH /api/chat/intent/:id — 400 on malformed id', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/chat/intent/not-a-bigint',
      headers: { cookie },
      payload: { overrideIntent: 'ASK' },
    });
    assert.strictEqual(response.statusCode, 400);
  });

  // Always close + clean up at end so suite doesn't leak rows.
  await t.test('Cleanup', async () => {
    await cleanup();
    await app.close();
  });
});
