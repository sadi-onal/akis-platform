import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { oauthAccounts, users } from '../db/schema.js';
import { requireAuth } from '../utils/auth.js';
import { getEnv } from '../config/env.js';
import { DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER } from '../core/orchestrator/AgentOrchestrator.js';
import { hashPassword } from '../services/auth/password.js';
import { sign } from '../services/auth/jwt.js';
import { cookieOpts, env as authEnv } from '../lib/env.js';

const bootstrapBodySchema = z
  .object({
    providerAccountId: z.string().max(255).optional(),
  })
  .optional();

// E2E test user credentials
const E2E_TEST_USER = {
  email: 'e2e-test@akis.local',
  name: 'E2E Test User',
  password: 'e2e-test-password-123',
};

export async function testHelpersRoutes(fastify: FastifyInstance) {
  const env = getEnv();
  // E2E test routes are only mounted under NODE_ENV=test. The previous
  // E2E === '1' env-var escape hatch was removed (prod-hardening): we don't
  // want a single env var to expose /test/e2e/login in any non-test env.
  const isE2EMode = env.NODE_ENV === 'test';
  const devBootstrapEnabled = env.NODE_ENV !== 'production' && process.env.SCRIBE_DEV_GITHUB_BOOTSTRAP === 'true';

  // E2E login endpoint - ONLY available in test/E2E mode
  if (isE2EMode) {
    fastify.post(
      '/e2e/login',
      {
        schema: {
          hide: true,
          tags: ['test'],
          description: 'E2E test login - creates test user if needed and returns session',
          response: {
            200: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      async (_request, reply) => {
        try {
          // Find or create test user
          let user = await db.query.users.findFirst({
            where: eq(users.email, E2E_TEST_USER.email),
          });

          if (!user) {
            const passwordHash = await hashPassword(E2E_TEST_USER.password);
            const [created] = await db
              .insert(users)
              .values({
                name: E2E_TEST_USER.name,
                email: E2E_TEST_USER.email,
                passwordHash,
                emailVerified: true, // Pre-verified for E2E
              })
              .returning();
            user = created;
          }

          // Create JWT and set cookie
          const jwt = await sign({ sub: user.id, email: user.email, name: user.name });
          reply.setCookie(authEnv.AUTH_COOKIE_NAME, jwt, cookieOpts);

          return {
            ok: true,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
            },
          };
        } catch (error) {
          fastify.log.error({ err: error }, 'E2E login failed');
          reply.code(500).send({ error: 'E2E_LOGIN_FAILED' });
        }
      }
    );

    // E2E logout endpoint
    fastify.post(
      '/e2e/logout',
      {
        schema: {
          hide: true,
          tags: ['test'],
          description: 'E2E test logout - clears session',
        },
      },
      async (_request, reply) => {
        reply.setCookie(authEnv.AUTH_COOKIE_NAME, '', { ...cookieOpts, maxAge: 0 });
        return { ok: true };
      }
    );
  }

  if (!devBootstrapEnabled) {
    return;
  }

  fastify.post(
    '/github/bootstrap',
    {
      schema: {
        hide: true,
        tags: ['test'],
        description: 'Dev/Test helper to mark current user as GitHub-connected without OAuth',
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
    async (request, reply) => {
      try {
        const body = bootstrapBodySchema.parse(request.body);
        const user = await requireAuth(request);

        const providerAccountId = body?.providerAccountId ?? `dev-github-${user.id}`;
        const existing = await db.query.oauthAccounts.findFirst({
          where: and(eq(oauthAccounts.userId, user.id), eq(oauthAccounts.provider, 'github')),
        });

        if (existing) {
          await db
            .update(oauthAccounts)
            .set({
              providerAccountId,
              accessToken: DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER,
              updatedAt: new Date(),
            })
            .where(eq(oauthAccounts.id, existing.id));
        } else {
          await db.insert(oauthAccounts).values({
            userId: user.id,
            provider: 'github',
            providerAccountId,
            accessToken: DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER,
          });
        }

        reply.send({ ok: true });
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          reply.code(401).send({ error: 'UNAUTHORIZED' });
          return;
        }
        fastify.log.error({ err: error }, 'Failed to bootstrap GitHub connection');
        reply.code(500).send({ error: 'FAILED_TO_BOOTSTRAP' });
      }
    }
  );
}

