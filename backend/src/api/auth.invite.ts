/**
 * Invite Authentication Routes
 * Admin-only invite creation + public invite validation/acceptance
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../services/auth/password.js';
import { sign, verify as verifyJwt } from '../services/auth/jwt.js';
import { cookieOpts, env } from '../lib/env.js';
import { InviteService } from '../services/auth/invite.js';
import type { EmailService } from '../services/email/index.js';
import { sendError } from '../utils/errorHandler.js';
import { logger } from '../lib/logger.js';

// Validation schemas
const CreateInviteSchema = z.object({
  email: z.string().email(),
});

const ValidateTokenSchema = z.object({
  token: z.string().min(1).max(128),
});

const AcceptInviteSchema = z.object({
  token: z.string().min(1).max(128),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8).max(100),
});

// Auth check helper
async function requireAdmin(request: FastifyRequest & { userId?: string }, reply: FastifyReply): Promise<void> {
  const token = request.cookies?.[env.AUTH_COOKIE_NAME];

  if (!token) {
    sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  try {
    const payload = await verifyJwt<{ sub: string }>(token);
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });

    if (!user || user.role !== 'admin') {
      sendError(reply, request, 'FORBIDDEN', 'Admin access required');
      return;
    }

    request.userId = payload.sub;
  } catch {
    reply.setCookie(env.AUTH_COOKIE_NAME, '', { ...cookieOpts, maxAge: 0 });
    sendError(reply, request, 'UNAUTHORIZED', 'Invalid session');
  }
}

export async function registerInviteRoutes(
  fastify: FastifyInstance,
  emailService: EmailService,
) {
  const publicUrl = env.FRONTEND_URL || 'https://staging.akisflow.com';
  const logoUrl = process.env.PUBLIC_LOGO_URL;

  const inviteService = new InviteService(emailService, {
    expiryDays: 7,
    publicUrl,
    logoUrl,
  });

  /**
   * POST /auth/invite — Admin creates invite
   */
  fastify.post('/invite', {
    preHandler: requireAdmin,
  }, async (request: FastifyRequest & { userId?: string }, reply) => {
    const body = CreateInviteSchema.parse(request.body);
    const adminUserId = request.userId as string;

    try {
      const result = await inviteService.createInvite(adminUserId, body.email);

      return reply.code(201).send({
        inviteId: result.inviteId,
        email: result.email,
        expiresAt: result.expiresAt.toISOString(),
        message: 'Davet e-postası gönderildi',
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'EMAIL_ALREADY_ACTIVE') {
          return sendError(reply, request, 'EMAIL_ALREADY_ACTIVE', 'Bu e-posta adresi zaten aktif bir hesaba sahip');
        }
      }
      logger.error(`[Invite] Failed to create invite: ${error}`);
      return sendError(reply, request, 'INTERNAL_ERROR', 'Davet oluşturulamadı');
    }
  });

  /**
   * GET /auth/invite/validate?token=xxx — Validate invite token (public)
   */
  fastify.get('/invite/validate', async (request, reply) => {
    const query = ValidateTokenSchema.parse(request.query);

    const result = await inviteService.validateToken(query.token);

    if (!result.valid) {
      return sendError(reply, request, 'INVITE_INVALID', 'Davet bağlantısı geçersiz veya süresi dolmuş');
    }

    return {
      valid: true,
      email: result.email,
      inviterName: result.inviterName,
      expiresAt: result.expiresAt?.toISOString(),
      existingUser: result.existingUser,
    };
  });

  /**
   * POST /auth/invite/accept — Accept invite + create account (public)
   */
  fastify.post('/invite/accept', async (request, reply) => {
    const body = AcceptInviteSchema.parse(request.body);

    // Validate token first
    const validation = await inviteService.validateToken(body.token);

    if (!validation.valid || !validation.email) {
      return sendError(reply, request, 'INVITE_INVALID', 'Davet bağlantısı geçersiz veya süresi dolmuş');
    }

    // Check if user already exists with this email
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, validation.email),
    });

    if (existingUser && existingUser.status === 'active') {
      return sendError(reply, request, 'EMAIL_ALREADY_ACTIVE', 'Bu e-posta adresi zaten aktif bir hesaba sahip. Lütfen giriş yapın.');
    }

    // Create new user (invited users are immediately active — email is pre-validated by invite)
    const name = `${body.firstName} ${body.lastName}`;
    const passwordHash = await hashPassword(body.password);

    let userId: string;

    if (existingUser && existingUser.status === 'pending_verification') {
      // Update the pending user
      await db
        .update(users)
        .set({
          name,
          passwordHash,
          status: 'active',
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id));
      userId = existingUser.id;
    } else {
      // Create new user
      const [created] = await db
        .insert(users)
        .values({
          name,
          email: validation.email,
          passwordHash,
          status: 'active',
          emailVerified: true,
        })
        .returning();
      userId = created.id;
    }

    // Accept the invite
    await inviteService.acceptInvite(body.token, userId);

    // Get the created/updated user
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return sendError(reply, request, 'INTERNAL_ERROR', 'Hesap oluşturulamadı');
    }

    // Generate JWT and set cookie
    const jwt = await sign({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    reply.setCookie(env.AUTH_COOKIE_NAME, jwt, cookieOpts);

    return reply.code(201).send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      message: 'Hesabınız başarıyla oluşturuldu',
    });
  });
}
