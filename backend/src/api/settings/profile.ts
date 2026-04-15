/**
 * Profile Settings API
 * GET /api/settings/profile - Get current user profile
 * PUT /api/settings/profile - Update profile (name only, email change requires verification)
 * PUT /api/settings/profile/password - Change password
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { requireAuth } from '../../utils/auth.js';
import { hashPassword, verifyPassword } from '../../services/auth/password.js';

const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export async function profileRoutes(fastify: FastifyInstance) {
  // GET /api/settings/profile - Get current user profile
  fastify.get(
    '/profile',
    {
      schema: {
        tags: ['settings'],
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
              emailVerified: { type: 'boolean' },
              status: { type: 'string' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = await requireAuth(request);

        const user = await db.query.users.findFirst({
          where: eq(users.id, currentUser.id),
          columns: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            status: true,
            createdAt: true,
          },
        });

        if (!user) {
          return reply.code(404).send({
            error: {
              code: 'USER_NOT_FOUND',
              message: 'User not found',
            },
          });
        }

        return reply.code(200).send({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          status: user.status,
          createdAt: user.createdAt?.toISOString(),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authentication required',
            },
          });
        }
        throw err;
      }
    }
  );

  // PUT /api/settings/profile - Update profile
  fastify.put(
    '/profile',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = await requireAuth(request);
        const body = updateProfileSchema.parse(request.body);

        await db
          .update(users)
          .set({
            name: body.name.trim(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, currentUser.id));

        return reply.code(200).send({
          success: true,
          name: body.name.trim(),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authentication required',
            },
          });
        }
        if (err instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid profile data',
              details: err.errors,
            },
          });
        }
        throw err;
      }
    }
  );

  // PUT /api/settings/profile/password - Change password
  fastify.put(
    '/profile/password',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string' },
            newPassword: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = await requireAuth(request);
        const body = changePasswordSchema.parse(request.body);

        // Get the user with password hash
        const user = await db.query.users.findFirst({
          where: eq(users.id, currentUser.id),
          columns: {
            id: true,
            passwordHash: true,
          },
        });

        if (!user) {
          return reply.code(404).send({
            error: {
              code: 'USER_NOT_FOUND',
              message: 'User not found',
            },
          });
        }

        // Check if this is an OAuth-only user (no password set)
        if (!user.passwordHash) {
          return reply.code(400).send({
            error: {
              code: 'OAUTH_USER',
              message: 'Cannot change password for OAuth-linked accounts without a password',
            },
          });
        }

        // Verify current password
        const isValid = await verifyPassword(body.currentPassword, user.passwordHash);
        if (!isValid) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_PASSWORD',
              message: 'Current password is incorrect',
            },
          });
        }

        // Hash and save new password
        const newPasswordHash = await hashPassword(body.newPassword);
        await db
          .update(users)
          .set({
            passwordHash: newPasswordHash,
            updatedAt: new Date(),
          })
          .where(eq(users.id, currentUser.id));

        return reply.code(200).send({
          success: true,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authentication required',
            },
          });
        }
        if (err instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid password data',
              details: err.errors,
            },
          });
        }
        throw err;
      }
    }
  );
}
