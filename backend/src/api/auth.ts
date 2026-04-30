import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../services/auth/password.js';
import { sign, verify } from '../services/auth/jwt.js';
import { cookieOpts, env } from '../lib/env.js';
import { getEnv } from '../config/env.js';
import { createEmailService } from '../services/email/index.js';
import { registerMultiStepAuthRoutes } from './auth.multi-step.js';
import { registerOAuthRoutes } from './auth.oauth.js';
import { registerInviteRoutes } from './auth.invite.js';
import { sendError } from '../utils/errorHandler.js';
import { requireAuth } from '../utils/auth.js';
import { isDevMode } from '../config/devMode.js';

type User = typeof users.$inferSelect;

const SignupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const sanitizeUser = (user: User) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  // Avatar priority: user-uploaded > GitHub-cached > null (UI falls back to initials).
  // Issue #385 / BUG-05.
  avatarUrl: user.avatarUrl ?? user.githubAvatarUrl ?? null,
});

function clearSessionCookie(reply: FastifyReply) {
  reply.setCookie(env.AUTH_COOKIE_NAME, '', { ...cookieOpts, maxAge: 0 });
}

export async function authRoutes(fastify: FastifyInstance) {
  // Initialize email service
  const config = getEnv();
  const emailService = createEmailService({
    provider: config.EMAIL_PROVIDER,
    // Resend
    apiKey: config.RESEND_API_KEY,
    fromEmail: config.RESEND_FROM_EMAIL,
    // SMTP
    smtpHost: config.SMTP_HOST,
    smtpPort: config.SMTP_PORT,
    smtpSecure: config.SMTP_SECURE,
    smtpUser: config.SMTP_USER,
    smtpPass: config.SMTP_PASS,
    smtpFromName: config.SMTP_FROM_NAME,
    smtpFromEmail: config.SMTP_FROM_EMAIL,
    smtpReplyTo: config.SMTP_REPLY_TO,
    // Shared
    publicLogoUrl: config.PUBLIC_LOGO_URL,
    ttlMinutes: config.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES,
  });

  // Register multi-step auth routes
  await registerMultiStepAuthRoutes(fastify, emailService);

  // Register OAuth routes (S0.4.2) — inject emailService for welcome emails
  await registerOAuthRoutes(fastify, emailService);

  // Register invite routes (WL-1)
  await registerInviteRoutes(fastify, emailService);

  // Legacy routes (deprecated - kept for backwards compatibility)
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              ts: { type: 'string' },
            },
          },
        },
      },
    },
    async () => {
      return {
        ok: true,
        ts: new Date().toISOString(),
      };
    }
  );

  // DEPRECATED: Single-step signup (kept for backwards compatibility)
  fastify.post('/signup', async (request, reply) => {
    const body = SignupSchema.parse(request.body);
    const email = body.email.toLowerCase();
    const passwordHash = await hashPassword(body.password);

    // Wrap in transaction to prevent TOCTOU race between email-exists check and insert
    const created = await db.transaction(async (tx) => {
      const existing = await tx.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (existing) {
        return null;
      }

      const [inserted] = await tx
        .insert(users)
        .values({
          name: body.name,
          email,
          passwordHash,
        })
        .returning();

      return inserted;
    });

    if (!created) {
      return sendError(reply, request, 'EMAIL_IN_USE', 'Email in use');
    }

    const jwt = await sign({ sub: created.id, email: created.email, name: created.name });
    reply.setCookie(env.AUTH_COOKIE_NAME, jwt, cookieOpts);

    return reply.code(201).send(sanitizeUser(created));
  });

  // DEPRECATED: Single-step login (kept for backwards compatibility)
  fastify.post('/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const user = await db.query.users.findFirst({
      where: eq(users.email, body.email.toLowerCase()),
    });

    if (!user) {
      return sendError(reply, request, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    const isValid = await verifyPassword(body.password, user.passwordHash);
    if (!isValid) {
      return sendError(reply, request, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    const jwt = await sign({ sub: user.id, email: user.email, name: user.name });
    reply.setCookie(env.AUTH_COOKIE_NAME, jwt, cookieOpts);

    return sanitizeUser(user);
  });

  fastify.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        description: 'Logout current user by clearing session cookie',
        // No body validation - logout accepts empty body
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      clearSessionCookie(reply);
      return { ok: true };
    }
  );

  fastify.get('/me', async (request, reply) => {
    const token = request.cookies?.[env.AUTH_COOKIE_NAME];
    if (token) {
      try {
        const payload = await verify<{ sub: string }>(token);
        const user = await db.query.users.findFirst({
          where: eq(users.id, payload.sub),
        });
        if (user) return sanitizeUser(user);
        clearSessionCookie(reply);
      } catch {
        clearSessionCookie(reply);
      }
    }

    // DEV_MODE: fall back to first active user when no valid session cookie
    if (isDevMode()) {
      const devUser = await db.query.users.findFirst({
        where: eq(users.status, 'active'),
      });
      if (devUser) return sanitizeUser(devUser);
    }

    return reply.code(401).send({ user: null });
  });

  // ── Profile & Account Management endpoints ──

  const authPreHandler = async (request: FastifyRequest) => {
    try {
      const user = await requireAuth(request);
      (request as unknown as Record<string, unknown>).__authUser = user;
      return;
    } catch {
      if (isDevMode()) {
        const devUser = await db.query.users.findFirst({
          where: eq(users.status, 'active'),
        });
        if (devUser) {
          (request as unknown as Record<string, unknown>).__authUser = { id: devUser.id, email: devUser.email, name: devUser.name, role: 'member' };
          return;
        }
      }
      throw Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
    }
  };

  const getUser = (request: FastifyRequest) =>
    (request as unknown as Record<string, unknown>).__authUser as { id: string; email: string; name: string; role: string };

  // GET /auth/profile — full profile with github info
  fastify.get('/profile', { preHandler: authPreHandler }, async (request, reply) => {
    const authUser = getUser(request);
    const user = await db.query.users.findFirst({
      where: eq(users.id, authUser.id),
    });

    if (!user) {
      return sendError(reply, request, 'UNAUTHORIZED', 'User not found');
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: (user as { role?: string }).role || 'member',
      emailVerified: user.emailVerified,
      githubUsername: user.githubUsername || null,
      githubAvatarUrl: user.githubAvatarUrl || null,
      createdAt: user.createdAt,
    };
  });

  const UpdateProfileSchema = z.object({
    name: z.string().min(2).max(100).optional(),
    email: z.string().email().optional(),
  });

  // ─── Avatar upload (issue #385 / BUG-05) ─────────────────
  // MVP stores the image as a data URL directly in users.avatar_url. This
  // avoids bringing OCI Object Storage into the MVP path and is fine for
  // <=1MB encoded payloads at demo scale. The client enforces the same cap.
  const MAX_AVATAR_DATA_URL_CHARS = 1_700_000; // ~1.25 MB raw image encoded
  const AVATAR_DATA_URL_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

  const UploadAvatarSchema = z.object({
    avatarUrl: z
      .string()
      .min(10)
      .max(MAX_AVATAR_DATA_URL_CHARS, 'Avatar too large — resize under ~1MB')
      .regex(AVATAR_DATA_URL_PREFIX, 'Must be a data:image/{png,jpeg,webp,gif};base64 URL')
      .nullable(),
  });

  // PUT /auth/avatar — set or clear the user-uploaded avatar
  fastify.put('/avatar', { preHandler: authPreHandler }, async (request, reply) => {
    const authUser = getUser(request);
    const body = UploadAvatarSchema.parse(request.body);
    await db
      .update(users)
      .set({ avatarUrl: body.avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, authUser.id));
    const updated = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
    if (!updated) {
      return sendError(reply, request, 'UNAUTHORIZED', 'User not found');
    }
    return sanitizeUser(updated);
  });

  // PUT /auth/profile — update name/email
  fastify.put('/profile', { preHandler: authPreHandler }, async (request, reply) => {
    const authUser = getUser(request);
    const body = UpdateProfileSchema.parse(request.body);

    if (!body.name && !body.email) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'At least one field required' } });
    }

    // Check email uniqueness if changing
    if (body.email) {
      const existing = await db.query.users.findFirst({
        where: eq(users.email, body.email.toLowerCase()),
      });
      if (existing && existing.id !== authUser.id) {
        return sendError(reply, request, 'EMAIL_IN_USE', 'Email already in use');
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name) updates.name = body.name;
    if (body.email) updates.email = body.email.toLowerCase();

    await db.update(users).set(updates).where(eq(users.id, authUser.id));

    const updated = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
    return sanitizeUser(updated!);
  });

  const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  });

  // PUT /auth/password — change password
  fastify.put('/password', { preHandler: authPreHandler }, async (request, reply) => {
    const authUser = getUser(request);

    const body = ChangePasswordSchema.parse(request.body);

    const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
    if (!user) throw new Error('UNAUTHORIZED');

    const isValid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!isValid) {
      return sendError(reply, request, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }

    const newHash = await hashPassword(body.newPassword);
    await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, authUser.id));

    return { ok: true };
  });

  // DELETE /auth/account — soft-delete (set status to 'deleted')
  fastify.route({
    method: 'DELETE',
    url: '/account',
    preHandler: authPreHandler,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const authUser = getUser(request);

      await db.update(users).set({
        status: 'deleted',
        githubToken: null,
        githubUsername: null,
        githubAvatarUrl: null,
        updatedAt: new Date(),
      }).where(eq(users.id, authUser.id));

      clearSessionCookie(reply);
      return { ok: true };
    },
  });
}
