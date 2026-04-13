/**
 * Email Verification Service
 * Handles generation, storage, and validation of email verification codes
 */

import { db } from '../../db/client.js';
import { emailVerificationTokens, users } from '../../db/schema.js';
import { eq, and, gte, lt, isNull } from 'drizzle-orm';
import type { EmailService } from '../email/EmailService.js';
import { logger } from '../../lib/logger.js';

export interface VerificationCodeOptions {
  ttlMinutes?: number;
}

const MAX_VERIFY_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

export class VerificationService {
  private readonly emailService: EmailService;
  private readonly ttlMinutes: number;
  /** Tracks failed verification attempts per userId to prevent brute-force on 6-digit codes. */
  private readonly failedAttempts = new Map<string, { count: number; lockedUntil?: number }>();

  constructor(emailService: EmailService, options: VerificationCodeOptions = {}) {
    this.emailService = emailService;
    this.ttlMinutes = options.ttlMinutes || 15;
  }

  /**
   * Generate a random 6-digit code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Create and send a new verification code for a user
   * @throws Error if rate limit exceeded or email service fails
   */
  async sendVerificationCode(userId: string, email: string, name?: string): Promise<void> {
    // Check rate limit: max 3 unused codes in last 15 minutes
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    
    const recentTokens = await db.query.emailVerificationTokens.findMany({
      where: and(
        eq(emailVerificationTokens.userId, userId),
        gte(emailVerificationTokens.createdAt, fifteenMinutesAgo),
        isNull(emailVerificationTokens.usedAt)
      ),
    });

    if (recentTokens.length >= 3) {
      throw new Error('TOO_MANY_ATTEMPTS');
    }

    // Generate new code
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60 * 1000);

    // Store in database
    await db.insert(emailVerificationTokens).values({
      userId,
      email: email.toLowerCase(),
      code,
      expiresAt,
    });

    // Send email
    await this.emailService.sendVerificationCode(email, code, name);
  }

  /**
   * Verify a code for a user
   * @returns userId if valid, null if invalid/expired
   * @throws Error if too many invalid attempts
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    // Check lockout (brute-force protection for 6-digit codes)
    const attempts = this.failedAttempts.get(userId);
    if (attempts?.lockedUntil && Date.now() < attempts.lockedUntil) {
      throw new Error('VERIFICATION_LOCKED');
    }

    // Find the most recent unused token for this user with this code
    const token = await db.query.emailVerificationTokens.findFirst({
      where: and(
        eq(emailVerificationTokens.userId, userId),
        eq(emailVerificationTokens.code, code),
        isNull(emailVerificationTokens.usedAt)
      ),
      orderBy: (tokens, { desc }) => [desc(tokens.createdAt)],
    });

    if (!token || new Date() > token.expiresAt) {
      // Track failed attempt
      const current = this.failedAttempts.get(userId) ?? { count: 0 };
      current.count += 1;
      if (current.count >= MAX_VERIFY_ATTEMPTS) {
        current.lockedUntil = Date.now() + LOCKOUT_MS;
        logger.warn(`[Verification] User ${userId} locked out after ${MAX_VERIFY_ATTEMPTS} failed attempts`);
      }
      this.failedAttempts.set(userId, current);
      return false;
    }

    // Success — atomically mark as used (prevents race condition with concurrent requests)
    const [marked] = await db
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(emailVerificationTokens.id, token.id),
        isNull(emailVerificationTokens.usedAt),
      ))
      .returning();

    if (!marked) {
      // Token was consumed by a concurrent request
      return false;
    }

    this.failedAttempts.delete(userId);

    // Update user status
    await db
      .update(users)
      .set({
        emailVerified: true,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return true;
  }

  /**
   * Clean up expired tokens (can be run periodically)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const result = await db
      .delete(emailVerificationTokens)
      .where(
        lt(emailVerificationTokens.expiresAt, new Date())
      )
      .returning();

    return result.length;
  }
}

