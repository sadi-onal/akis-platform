/**
 * Workspace Settings API
 * MVP: Single workspace per user (workspace = user account)
 * GET /api/settings/workspace - Get workspace info
 * PUT /api/settings/workspace - Update workspace name (actually updates user name)
 * DELETE /api/settings/workspace - Delete account (with confirmation)
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, oauthAccounts, userAiKeys, integrationCredentials, agentConfigs } from '../../db/schema.js';
import { requireAuth } from '../../utils/auth.js';
import { verifyPassword } from '../../services/auth/password.js';

const updateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Name is too long'),
});

const deleteWorkspaceSchema = z.object({
  confirmation: z.literal('DELETE MY ACCOUNT'),
  password: z.string().optional(), // Required for password accounts, not for OAuth-only
});

export async function workspaceRoutes(fastify: FastifyInstance) {
  // GET /api/settings/workspace - Get workspace info
  fastify.get(
    '/workspace',
    {
      schema: {
        tags: ['settings'],
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              ownerEmail: { type: 'string' },
              createdAt: { type: 'string' },
              plan: { type: 'string' },
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
            createdAt: true,
          },
        });

        if (!user) {
          return reply.code(404).send({
            error: {
              code: 'WORKSPACE_NOT_FOUND',
              message: 'Workspace not found',
            },
          });
        }

        // In MVP, workspace ID = user ID with 'ws_' prefix
        return reply.code(200).send({
          id: `ws_${user.id.slice(0, 8)}`,
          name: `${user.name}'s Workspace`,
          ownerEmail: user.email,
          createdAt: user.createdAt?.toISOString(),
          plan: 'free', // MVP: all workspaces are free
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

  // PUT /api/settings/workspace - Update workspace name
  fastify.put(
    '/workspace',
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
        const body = updateWorkspaceSchema.parse(request.body);

        // In MVP, workspace name = user name
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
              message: 'Invalid workspace data',
              details: err.errors,
            },
          });
        }
        throw err;
      }
    }
  );

  // DELETE /api/settings/workspace - Delete account
  fastify.delete(
    '/workspace',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 hour',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['confirmation'],
          properties: {
            confirmation: { type: 'string' },
            password: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = await requireAuth(request);
        const body = deleteWorkspaceSchema.parse(request.body);

        // Get user with password hash to determine auth type
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

        // If user has a password, require it for deletion
        if (user.passwordHash && user.passwordHash.length > 0) {
          if (!body.password) {
            return reply.code(400).send({
              error: {
                code: 'PASSWORD_REQUIRED',
                message: 'Password is required to delete your account',
              },
            });
          }

          const isValid = await verifyPassword(body.password, user.passwordHash);
          if (!isValid) {
            return reply.code(400).send({
              error: {
                code: 'INVALID_PASSWORD',
                message: 'Incorrect password',
              },
            });
          }
        }

        // Soft delete: mark user as deleted instead of hard delete
        // This preserves referential integrity and allows recovery
        await db
          .update(users)
          .set({
            status: 'deleted',
            updatedAt: new Date(),
          })
          .where(eq(users.id, currentUser.id));

        // Clean up related data (optional: could keep for audit)
        // Delete OAuth accounts
        await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, currentUser.id));
        // Delete AI keys
        await db.delete(userAiKeys).where(eq(userAiKeys.userId, currentUser.id));
        // Delete integration credentials
        await db.delete(integrationCredentials).where(eq(integrationCredentials.userId, currentUser.id));
        // Delete agent configs
        await db.delete(agentConfigs).where(eq(agentConfigs.userId, currentUser.id));

        // Clear the session cookie
        reply.clearCookie('akis_sid', { path: '/' });

        return reply.code(200).send({
          success: true,
          message: 'Your account has been deleted. All associated data has been removed.',
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
              message: 'Invalid request data',
              details: err.errors,
            },
          });
        }
        throw err;
      }
    }
  );
}
