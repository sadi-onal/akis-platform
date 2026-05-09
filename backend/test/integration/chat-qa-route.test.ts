/**
 * Integration test for the chat-qa route (FR-10).
 *
 * Exercises:
 *   - POST /api/chat-qa/ask returns SSE stream with chunk + done events
 *   - 401 when unauthenticated
 *   - 400 when message missing
 *   - Authenticated request finishes with a non-empty answer
 *
 * Skipped cleanly when DATABASE_URL is unset.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../src/services/auth/password.js';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';

const hasDatabase = !!process.env.DATABASE_URL;

interface SSEEvent {
  event: string;
  data: unknown;
}

/**
 * Parse a raw SSE stream body into a list of {event, data} objects. Lines
 * are framed by a blank line; events default to 'message' when omitted.
 */
function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split(/\n\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join('\n');
    let data: unknown = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      /* keep as raw text */
    }
    events.push({ event, data });
  }
  return events;
}

test('Chat Q&A route (FR-10)', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    console.log('Skipping: DATABASE_URL not set');
    return;
  }

  const app = await buildApp();
  const userId = randomUUID();
  const userEmail = `chat-qa-route-${Date.now()}@test.local`;
  const password = 'test-password-123';

  const cleanup = async () => {
    try {
      await db.delete(users).where(eq(users.id, userId));
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  };

  await t.test('Setup: create active user', async () => {
    const hash = await hashPassword(password);
    await db.insert(users).values({
      id: userId,
      name: 'ChatQA Tester',
      email: userEmail,
      passwordHash: hash,
      emailVerified: true,
      status: 'active',
    });
  });

  const jwt = await sign({ sub: userId, email: userEmail, name: 'ChatQA Tester' });
  const cookie = `${authEnv.AUTH_COOKIE_NAME}=${jwt}`;

  await t.test('POST /api/chat-qa/ask — 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat-qa/ask',
      payload: { message: 'kaç dosya?' },
    });
    assert.strictEqual(response.statusCode, 401);
  });

  await t.test('POST /api/chat-qa/ask — 400 when message missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat-qa/ask',
      headers: { cookie },
      payload: {},
    });
    assert.strictEqual(response.statusCode, 400);
  });

  await t.test('POST /api/chat-qa/ask — streams SSE with chunks + done', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat-qa/ask',
      headers: { cookie },
      payload: { message: 'Kaç dosya üretildi?' },
    });

    assert.strictEqual(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /event-stream/);

    const events = parseSSE(response.body);
    // Should have ≥1 chunk and exactly 1 done.
    const chunks = events.filter((e) => e.event === 'chunk');
    const dones = events.filter((e) => e.event === 'done');
    const errors = events.filter((e) => e.event === 'error');

    assert.ok(chunks.length >= 1, `expected at least one chunk, got ${chunks.length}`);
    assert.strictEqual(dones.length, 1, 'expected exactly one done event');
    assert.strictEqual(errors.length, 0, `expected no error events, got ${errors.length}`);

    const done = dones[0].data as {
      answer: string;
      citations: unknown[];
      needsBuild: boolean;
    };
    assert.ok(typeof done.answer === 'string' && done.answer.length > 0);
    assert.ok(Array.isArray(done.citations));
    assert.strictEqual(typeof done.needsBuild, 'boolean');

    // Re-assembling chunks reproduces the answer (mock provider invariant).
    const reassembled = chunks.map((e) => (e.data as { text: string }).text).join('');
    assert.strictEqual(reassembled, done.answer);
  });

  await t.test('POST /api/chat-qa/ask — accepts history without changing shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat-qa/ask',
      headers: { cookie },
      payload: {
        message: 'devam edelim mi?',
        history: [
          { role: 'user', content: 'projem nedir?' },
          { role: 'assistant', content: 'stok takibi.' },
        ],
      },
    });
    assert.strictEqual(response.statusCode, 200);
    const events = parseSSE(response.body);
    assert.ok(events.find((e) => e.event === 'done'));
  });

  await t.test('Cleanup', async () => {
    await cleanup();
    await app.close();
  });
});
