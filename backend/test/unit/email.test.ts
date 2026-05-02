/**
 * Unit tests for email service — templates, factory, SMTP config
 *
 * Tests template rendering (Turkish content, logo injection),
 * factory gating, isEmailConfigured, and SmtpEmailService constructor.
 * No real SMTP connection is used.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// ─── Template tests ──────────────────────────────────────────────────────────

import {
  verificationCodeHtml,
  verificationCodeText,
  welcomeHtml,
  welcomeText,
  inviteHtml,
  inviteText,
} from '../../src/services/email/templates.js';

describe('Email Templates — Turkish', () => {
  // ---------- Verification Code ----------
  describe('verificationCodeHtml', () => {
    test('contains the 6-digit code', () => {
      const html = verificationCodeHtml({ code: '123456' });
      assert.ok(html.includes('123456'), 'HTML must contain the code');
    });

    test('uses Turkish greeting with name', () => {
      const html = verificationCodeHtml({ code: '000000', name: 'Ömer' });
      assert.ok(html.includes('Merhaba Ömer,'), 'Should greet by name in Turkish');
    });

    test('uses generic greeting without name', () => {
      const html = verificationCodeHtml({ code: '000000' });
      assert.ok(html.includes('Merhaba,'), 'Should use generic Turkish greeting');
      assert.ok(!html.includes('Merhaba undefined'), 'Should not print undefined');
    });

    test('shows custom TTL in minutes', () => {
      const html = verificationCodeHtml({ code: '000000', ttlMinutes: 10 });
      assert.ok(html.includes('10 dakika'), 'Should show custom TTL');
    });

    test('injects logo URL when provided', () => {
      const url = 'https://cdn.akisflow.com/logo.png';
      const html = verificationCodeHtml({ code: '000000', logoUrl: url });
      assert.ok(html.includes(url), 'Should contain logo URL');
      assert.ok(html.includes('<img'), 'Should render an img tag');
    });

    test('falls back to text header without logo URL', () => {
      const html = verificationCodeHtml({ code: '000000' });
      assert.ok(html.includes('AKIS Platform'), 'Should have text fallback');
      assert.ok(!html.includes('<img'), 'Should NOT render img when no logo URL');
    });

    test('includes Turkish safety note', () => {
      const html = verificationCodeHtml({ code: '000000' });
      assert.ok(
        html.includes('siz talep etmediyseniz'),
        'Should contain Turkish safety text',
      );
    });

    test('sets lang="tr" on html element', () => {
      const html = verificationCodeHtml({ code: '000000' });
      assert.ok(html.includes('lang="tr"'), 'Should set Turkish language');
    });
  });

  describe('verificationCodeText', () => {
    test('contains the code', () => {
      const text = verificationCodeText({ code: '654321' });
      assert.ok(text.includes('654321'), 'Text must contain code');
    });

    test('is Turkish', () => {
      const text = verificationCodeText({ code: '000000' });
      assert.ok(text.includes('AKIS Platform hesabınızı doğrulamak'), 'Text must be in Turkish');
    });

    test('includes copyright', () => {
      const text = verificationCodeText({ code: '000000' });
      assert.ok(text.includes('AKIS Platform'), 'Should reference AKIS Platform');
    });
  });

  // ---------- Welcome ----------
  describe('welcomeHtml', () => {
    test('contains Turkish welcome message', () => {
      const html = welcomeHtml({});
      assert.ok(html.includes('hoş geldiniz'), 'Should contain Turkish welcome');
    });

    test('includes login URL', () => {
      const url = 'https://akisflow.com/login';
      const html = welcomeHtml({ loginUrl: url });
      assert.ok(html.includes(url), 'Should contain login URL');
    });

    test('mentions AI agents', () => {
      const html = welcomeHtml({});
      assert.ok(html.includes('Scribe'), 'Should mention Scribe agent');
      assert.ok(html.includes('Trace'), 'Should mention Trace agent');
      assert.ok(html.includes('Proto'), 'Should mention Proto agent');
    });
  });

  describe('welcomeText', () => {
    test('is Turkish', () => {
      const text = welcomeText({});
      assert.ok(text.includes('hoş geldiniz'), 'Text must be in Turkish');
    });
  });

  // ---------- Invite ----------
  describe('inviteHtml', () => {
    test('shows inviter name', () => {
      const html = inviteHtml({
        inviterName: 'Ahmet',
        recipientEmail: 'test@test.com',
        inviteUrl: 'https://akisflow.com/invite/abc',
      });
      assert.ok(html.includes('Ahmet'), 'Should contain inviter name');
    });

    test('includes invite URL', () => {
      const url = 'https://akisflow.com/invite/abc';
      const html = inviteHtml({
        inviterName: 'Test',
        recipientEmail: 'x@y.com',
        inviteUrl: url,
      });
      assert.ok(html.includes(url), 'Should contain invite URL');
    });

    test('mentions 7-day expiry', () => {
      const html = inviteHtml({
        inviterName: 'Test',
        recipientEmail: 'x@y.com',
        inviteUrl: 'https://example.com',
      });
      assert.ok(html.includes('7 gün'), 'Should mention 7-day validity');
    });
  });

  describe('inviteText', () => {
    test('is Turkish', () => {
      const text = inviteText({
        inviterName: 'Test',
        recipientEmail: 'x@y.com',
        inviteUrl: 'https://example.com',
      });
      assert.ok(text.includes('davet etti'), 'Text must be in Turkish');
    });
  });
});

// ─── Factory / isEmailConfigured tests ────────────────────────────────────────

import {
  createEmailService,
  isEmailConfigured,
  MockEmailService,
} from '../../src/services/email/index.js';

describe('Email Factory', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure test env
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    // Restore
    process.env = { ...originalEnv };
  });

  test('createEmailService returns MockEmailService in test env', () => {
    const svc = createEmailService({ provider: 'mock' });
    assert.ok(svc instanceof MockEmailService, 'Should be MockEmailService');
  });

  test('createEmailService throws for smtp without config', () => {
    // Force non-test to trigger real path
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      assert.throws(
        () => createEmailService({ provider: 'smtp' }),
        /SMTP_/,
        'Should throw about missing SMTP vars',
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  test('createEmailService throws for resend without config', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      assert.throws(
        () => createEmailService({ provider: 'resend' }),
        /RESEND/,
        'Should throw about missing Resend vars',
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  test('createEmailService throws for unknown provider', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      assert.throws(
        () => createEmailService({ provider: 'mailchimp' as never }),
        /Unknown email provider/,
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

describe('isEmailConfigured', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('mock is always configured', () => {
    assert.strictEqual(isEmailConfigured('mock'), true);
  });

  test('smtp is not configured when SMTP_HOST missing', () => {
    delete process.env.SMTP_HOST;
    assert.strictEqual(isEmailConfigured('smtp'), false);
  });

  test('smtp is configured when all vars present', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM_EMAIL = 'noreply@example.com';
    assert.strictEqual(isEmailConfigured('smtp'), true);
  });

  test('resend is not configured without API key', () => {
    delete process.env.RESEND_API_KEY;
    assert.strictEqual(isEmailConfigured('resend'), false);
  });

  test('resend is configured with both vars', () => {
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.RESEND_FROM_EMAIL = 'noreply@example.com';
    assert.strictEqual(isEmailConfigured('resend'), true);
  });
});

// ─── SmtpEmailService constructor tests ──────────────────────────────────────

import { SmtpEmailService } from '../../src/services/email/SmtpEmailService.js';

describe('SmtpEmailService', () => {
  test('constructor does not throw with valid config', () => {
    assert.doesNotThrow(() => {
      new SmtpEmailService({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'user@example.com',
        pass: 'password',
        fromName: 'AKIS Platform',
        fromEmail: 'noreply@example.com',
      });
    });
  });

  test('verifyConnection returns false for unreachable host', async () => {
    const svc = new SmtpEmailService({
      host: 'localhost',
      port: 1,  // Nothing listens here
      secure: false,
      user: 'u',
      pass: 'p',
      fromName: 'Test',
      fromEmail: 'test@test.com',
    });
    const ok = await svc.verifyConnection();
    assert.strictEqual(ok, false, 'Should return false for unreachable SMTP');
  });

  test('sendEmail returns error for unreachable host', async () => {
    const svc = new SmtpEmailService({
      host: 'localhost',
      port: 1,
      secure: false,
      user: 'u',
      pass: 'p',
      fromName: 'Test',
      fromEmail: 'test@test.com',
    });
    const result = await svc.sendEmail({
      to: 'to@test.com',
      subject: 'Test',
      text: 'test',
    });
    assert.strictEqual(result.success, false, 'Should fail for unreachable host');
    assert.ok(result.error, 'Should have an error message');
  });
});

// ─── BaseEmailService.sendVerificationCode integration ───────────────────────

describe('BaseEmailService.sendVerificationCode (via MockEmailService)', () => {
  test('sends Turkish email with correct subject', async () => {
    // Capture the message sent through mock
    let capturedSubject = '';
    let capturedHtml = '';

    const mock = new MockEmailService();
    const origSend = mock.sendEmail.bind(mock);
    mock.sendEmail = async (msg) => {
      capturedSubject = msg.subject;
      capturedHtml = msg.html ?? '';
      return origSend(msg);
    };

    await mock.sendVerificationCode('test@example.com', '999999', 'Ali');

    assert.ok(
      capturedSubject.includes('Doğrulama'),
      `Subject should be Turkish, got: ${capturedSubject}`,
    );
    assert.ok(
      capturedHtml.includes('999999'),
      'HTML should contain the code',
    );
    assert.ok(
      capturedHtml.includes('Merhaba Ali,'),
      'HTML should greet by name in Turkish',
    );
  });
});

// ─── BaseEmailService.sendWelcomeEmail integration ────────────────────────────

describe('BaseEmailService.sendWelcomeEmail (via MockEmailService)', () => {
  test('sends Turkish welcome email with correct subject', async () => {
    let capturedSubject = '';
    let capturedHtml = '';
    let capturedText = '';

    const mock = new MockEmailService();
    const origSend = mock.sendEmail.bind(mock);
    mock.sendEmail = async (msg) => {
      capturedSubject = msg.subject;
      capturedHtml = msg.html ?? '';
      capturedText = msg.text ?? '';
      return origSend(msg);
    };

    await mock.sendWelcomeEmail('test@example.com', 'Ali');

    assert.ok(
      capturedSubject.includes('Hoş Geldiniz'),
      `Subject should be Turkish welcome, got: ${capturedSubject}`,
    );
    assert.ok(
      capturedHtml.includes('hoş geldiniz'),
      'HTML should contain Turkish welcome message',
    );
    assert.ok(
      capturedHtml.includes('Merhaba Ali,'),
      'HTML should greet by name in Turkish',
    );
    assert.ok(
      capturedText.includes('hoş geldiniz'),
      'Text should contain Turkish welcome message',
    );
  });

  test('includes default login URL', async () => {
    let capturedHtml = '';

    const mock = new MockEmailService();
    const origSend = mock.sendEmail.bind(mock);
    mock.sendEmail = async (msg) => {
      capturedHtml = msg.html ?? '';
      return origSend(msg);
    };

    await mock.sendWelcomeEmail('test@example.com');

    assert.ok(
      capturedHtml.includes('akisflow.com/login'),
      'HTML should contain default login URL',
    );
  });

  test('uses custom login URL when provided', async () => {
    let capturedHtml = '';

    const mock = new MockEmailService();
    const origSend = mock.sendEmail.bind(mock);
    mock.sendEmail = async (msg) => {
      capturedHtml = msg.html ?? '';
      return origSend(msg);
    };

    await mock.sendWelcomeEmail('test@example.com', 'Test', 'https://app.akisflow.com/login');

    assert.ok(
      capturedHtml.includes('https://app.akisflow.com/login'),
      'HTML should contain custom login URL',
    );
  });

  test('mentions Scribe, Trace, Proto agents', async () => {
    let capturedHtml = '';

    const mock = new MockEmailService();
    const origSend = mock.sendEmail.bind(mock);
    mock.sendEmail = async (msg) => {
      capturedHtml = msg.html ?? '';
      return origSend(msg);
    };

    await mock.sendWelcomeEmail('test@example.com');

    assert.ok(capturedHtml.includes('Scribe'), 'Should mention Scribe');
    assert.ok(capturedHtml.includes('Trace'), 'Should mention Trace');
    assert.ok(capturedHtml.includes('Proto'), 'Should mention Proto');
  });
});
