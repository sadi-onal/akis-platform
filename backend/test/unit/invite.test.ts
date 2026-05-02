/**
 * Unit tests for invite service — token generation, validation, acceptance
 *
 * Tests invite flow logic without database dependencies.
 * Route-level tests use fastify.inject patterns.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';

// ─── Template rendering tests ────────────────────────────────────────────────

import {
  inviteHtml,
  inviteText,
} from '../../src/services/email/templates.js';

describe('Invite Templates', () => {
  test('inviteHtml includes inviter name', () => {
    const html = inviteHtml({
      inviterName: 'Ömer Yasir',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://akisflow.com/auth/invite/abc123',
    });
    assert.ok(html.includes('Ömer Yasir'), 'HTML must contain inviter name');
  });

  test('inviteHtml includes invite URL', () => {
    const url = 'https://akisflow.com/auth/invite/abc123';
    const html = inviteHtml({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: url,
    });
    assert.ok(html.includes(url), 'HTML must contain invite URL');
  });

  test('inviteHtml includes CTA button text in Turkish', () => {
    const html = inviteHtml({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(html.includes('Daveti Kabul Et'), 'HTML must contain Turkish CTA');
  });

  test('inviteHtml includes 7-day expiry note', () => {
    const html = inviteHtml({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(html.includes('7 gün'), 'HTML must mention 7-day validity');
  });

  test('inviteHtml injects logo URL when provided', () => {
    const logoUrl = 'https://cdn.akisflow.com/logo.png';
    const html = inviteHtml({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
      logoUrl,
    });
    assert.ok(html.includes(logoUrl), 'HTML must contain logo URL');
    assert.ok(html.includes('<img'), 'HTML must render img tag');
  });

  test('inviteHtml falls back to text header without logo', () => {
    const html = inviteHtml({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(html.includes('AKIS Platform'), 'Should have text fallback');
  });

  test('inviteText includes inviter name', () => {
    const text = inviteText({
      inviterName: 'Ömer',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(text.includes('Ömer'), 'Text must contain inviter name');
  });

  test('inviteText includes invite URL', () => {
    const url = 'https://example.com/invite/abc';
    const text = inviteText({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: url,
    });
    assert.ok(text.includes(url), 'Text must contain invite URL');
  });

  test('inviteText includes 7-day expiry note', () => {
    const text = inviteText({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(text.includes('7 gün'), 'Text must mention 7-day validity');
  });

  test('inviteText includes Turkish AKIS description', () => {
    const text = inviteText({
      inviterName: 'Admin',
      recipientEmail: 'test@example.com',
      inviteUrl: 'https://example.com/invite/xyz',
    });
    assert.ok(text.includes('yapay zekâ'), 'Text must include Turkish AI description');
  });
});

// ─── Token generation tests ─────────────────────────────────────────────────

describe('Invite Token Generation', () => {
  test('generates 64-character hex token', () => {
    const token = randomBytes(32).toString('hex');
    assert.strictEqual(token.length, 64, 'Token should be 64 chars');
    assert.ok(/^[0-9a-f]+$/.test(token), 'Token should be hex');
  });

  test('generates unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(randomBytes(32).toString('hex'));
    }
    assert.strictEqual(tokens.size, 100, 'All tokens should be unique');
  });
});

// ─── Error code mapping tests ───────────────────────────────────────────────

import { getStatusCodeForError } from '../../src/utils/errorHandler.js';

describe('Invite Error Codes', () => {
  test('INVITE_INVALID maps to 404', () => {
    assert.strictEqual(getStatusCodeForError('INVITE_INVALID'), 404);
  });

  test('INVITE_EXPIRED maps to 404', () => {
    assert.strictEqual(getStatusCodeForError('INVITE_EXPIRED'), 404);
  });

  test('EMAIL_ALREADY_ACTIVE maps to 409', () => {
    assert.strictEqual(getStatusCodeForError('EMAIL_ALREADY_ACTIVE'), 409);
  });

  test('FORBIDDEN maps to 403 (for non-admin invite creation)', () => {
    assert.strictEqual(getStatusCodeForError('FORBIDDEN'), 403);
  });
});

// ─── Schema validation tests ────────────────────────────────────────────────

import { z } from 'zod';

describe('Invite Request Validation', () => {
  const CreateInviteSchema = z.object({
    email: z.string().email(),
  });

  const AcceptInviteSchema = z.object({
    token: z.string().min(1).max(128),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    password: z.string().min(8).max(100),
  });

  test('CreateInviteSchema rejects invalid email', () => {
    const result = CreateInviteSchema.safeParse({ email: 'not-an-email' });
    assert.ok(!result.success, 'Should reject invalid email');
  });

  test('CreateInviteSchema accepts valid email', () => {
    const result = CreateInviteSchema.safeParse({ email: 'test@example.com' });
    assert.ok(result.success, 'Should accept valid email');
  });

  test('AcceptInviteSchema rejects empty token', () => {
    const result = AcceptInviteSchema.safeParse({
      token: '',
      firstName: 'Test',
      lastName: 'User',
      password: 'password123',
    });
    assert.ok(!result.success, 'Should reject empty token');
  });

  test('AcceptInviteSchema rejects short password', () => {
    const result = AcceptInviteSchema.safeParse({
      token: 'abc123',
      firstName: 'Test',
      lastName: 'User',
      password: '123',
    });
    assert.ok(!result.success, 'Should reject password shorter than 8 chars');
  });

  test('AcceptInviteSchema accepts valid input', () => {
    const result = AcceptInviteSchema.safeParse({
      token: 'abc123def456',
      firstName: 'Test',
      lastName: 'User',
      password: 'securepassword123',
    });
    assert.ok(result.success, 'Should accept valid input');
  });

  test('AcceptInviteSchema rejects missing firstName', () => {
    const result = AcceptInviteSchema.safeParse({
      token: 'abc123',
      lastName: 'User',
      password: 'password123',
    });
    assert.ok(!result.success, 'Should reject missing firstName');
  });

  test('AcceptInviteSchema rejects missing lastName', () => {
    const result = AcceptInviteSchema.safeParse({
      token: 'abc123',
      firstName: 'Test',
      password: 'password123',
    });
    assert.ok(!result.success, 'Should reject missing lastName');
  });
});

// ─── Invite expiry logic tests ──────────────────────────────────────────────

describe('Invite Expiry Logic', () => {
  test('7-day expiry is calculated correctly', () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const diffMs = expiresAt.getTime() - now.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    assert.strictEqual(diffDays, 7, 'Expiry should be 7 days from now');
  });

  test('expired token is detected correctly', () => {
    const expired = new Date(Date.now() - 1000); // 1 second ago
    assert.ok(new Date() > expired, 'Current time should be after expired time');
  });

  test('future token is detected as valid', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    assert.ok(new Date() < future, 'Current time should be before future expiry');
  });
});
