import { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { isEncryptionConfigured } from '../utils/crypto.js';
import { isEmailConfigured } from '../services/email/index.js';
import { getEnv } from '../config/env.js';
import { checkMcpHealth } from '../services/mcp/health.js';

// Build info - set at Docker build time via ARG/ENV
const BUILD_INFO = {
  version: process.env.npm_package_version || process.env.APP_VERSION || '0.2.0',
  commit: process.env.BUILD_COMMIT || process.env.GIT_COMMIT || 'unknown',
  buildTime: process.env.BUILD_TIME || 'unknown',
  environment: process.env.NODE_ENV || 'development',
  name: 'akis-backend',
};

// Startup time for uptime calculation
const START_TIME = new Date().toISOString();

export async function healthRoutes(fastify: FastifyInstance) {
  /**
   * GET /health - Basic liveness check
   * Returns 200 if the server is running
   * Used by: Load balancers, uptime monitors, CI/CD health gates
   */
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Health check endpoint (liveness). No auth required.',
        tags: ['meta'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              timestamp: { type: 'string', example: '2026-01-09T12:00:00.000Z' },
            },
          },
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    }
  );

  /**
   * GET /ready - Readiness check
   * Returns 200 if the server is ready to accept requests (DB connected)
   * Used by: Container orchestration, CI/CD deploy verification
   */
  fastify.get(
    '/ready',
    {
      schema: {
        description: 'Readiness check endpoint (includes DB connectivity). No auth required.',
        tags: ['meta'],
        response: {
          200: {
            type: 'object',
            properties: {
              ready: { type: 'boolean', example: true },
              database: { type: 'string', example: 'connected' },
              migrations: { type: 'string', example: 'ok' },
              encryption: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: true },
                },
              },
              email: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: true },
                  provider: { type: 'string', example: 'smtp' },
                },
              },
              oauth: {
                type: 'object',
                properties: {
                  google: { type: 'boolean', example: true },
                  github: { type: 'boolean', example: true },
                  callbackBase: { type: 'string', example: 'https://akisflow.com/auth/oauth' },
                },
              },
              mcp: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: true },
                  gatewayReachable: { type: 'boolean', example: true },
                  baseUrl: { type: 'string', nullable: true, example: 'http://mcp-gateway:4010/mcp' },
                  missingEnv: { type: 'array', items: { type: 'string' }, example: [] },
                  error: { type: 'string', nullable: true },
                },
              },
              timestamp: { type: 'string', example: '2026-01-09T12:00:00.000Z' },
            },
          },
          503: {
            type: 'object',
            properties: {
              ready: { type: 'boolean', example: false },
              database: { type: 'string', example: 'disconnected' },
              migrations: { type: 'string', example: 'unknown' },
              encryption: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: false },
                },
              },
              email: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: false },
                  provider: { type: 'string', example: 'mock' },
                },
              },
              oauth: {
                type: 'object',
                properties: {
                  google: { type: 'boolean', example: false },
                  github: { type: 'boolean', example: false },
                  callbackBase: { type: 'string' },
                },
              },
              mcp: {
                type: 'object',
                properties: {
                  configured: { type: 'boolean', example: false },
                  gatewayReachable: { type: 'boolean', example: false },
                  baseUrl: { type: 'string', nullable: true },
                  missingEnv: { type: 'array', items: { type: 'string' } },
                  error: { type: 'string', nullable: true },
                },
              },
              error: { type: 'string' },
              timestamp: { type: 'string', example: '2026-01-09T12:00:00.000Z' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const timestamp = new Date().toISOString();
      const encryptionStatus = { configured: isEncryptionConfigured() };
      const isProd = process.env.NODE_ENV === 'production';
      const emailProvider = process.env.EMAIL_PROVIDER || 'mock';
      const emailStatus: Record<string, unknown> = {
        configured: isEmailConfigured(emailProvider),
        provider: emailProvider,
      };

      // Add SMTP details only in non-production (prevents info leakage)
      if (emailProvider === 'smtp' && !isProd) {
        emailStatus.host = process.env.SMTP_HOST || null;
        emailStatus.port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
        emailStatus.from = process.env.SMTP_FROM_EMAIL || null;
        emailStatus.secure = process.env.SMTP_SECURE === 'true';
      }

      // OAuth provider readiness (no secrets, just configured/not)
      let oauthStatus: Record<string, unknown> = {};
      try {
        const cfg = getEnv();
        oauthStatus = {
          google: !!(cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET),
          github: !!(cfg.GITHUB_OAUTH_CLIENT_ID && cfg.GITHUB_OAUTH_CLIENT_SECRET),
          // Hide callback URL in production (reconnaissance prevention)
          ...(isProd ? {} : { callbackBase: cfg.BACKEND_URL ? `${cfg.BACKEND_URL}/auth/oauth` : 'NOT_SET' }),
        };
      } catch {
        oauthStatus = { google: false, github: false };
      }

      // MCP Gateway readiness (non-blocking, never leaks tokens)
      let mcpStatus: Record<string, unknown>;
      try {
        const mcpHealth = await checkMcpHealth();
        mcpStatus = {
          configured: !!mcpHealth.gatewayUrl && !!process.env.GITHUB_TOKEN,
          gatewayReachable: mcpHealth.healthy,
          // Hide internal URLs and missing env details in production
          ...(isProd ? {} : {
            baseUrl: mcpHealth.gatewayUrl || null,
            missingEnv: [
              ...(!mcpHealth.gatewayUrl ? ['GITHUB_MCP_BASE_URL'] : []),
              ...(!process.env.GITHUB_TOKEN ? ['GITHUB_TOKEN'] : []),
            ],
          }),
          error: (!mcpHealth.healthy && mcpHealth.error) ? mcpHealth.error : null,
        };
      } catch {
        mcpStatus = {
          configured: false,
          gatewayReachable: false,
          error: 'MCP health check failed unexpectedly',
        };
      }

      try {
        // Test database connectivity and verify core schema exists
        const result = await db.execute(
          sql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'users') AS has_users`
        );
        const rows = result.rows as Array<Record<string, unknown>>;
        const migrated = rows[0]?.has_users === true;
        return {
          ready: true,
          database: 'connected',
          migrations: migrated ? 'ok' : 'pending',
          encryption: encryptionStatus,
          email: emailStatus,
          oauth: oauthStatus,
          mcp: mcpStatus,
          timestamp,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        reply.code(503).send({
          ready: false,
          database: 'disconnected',
          migrations: 'unknown',
          encryption: encryptionStatus,
          email: emailStatus,
          oauth: oauthStatus,
          mcp: mcpStatus,
          error: errorMessage,
          timestamp,
        });
      }
    }
  );

  /**
   * GET /version - Application version and build info
   * Returns semantic version, git commit, build time for CI/CD verification
   * Used by: Deploy pipelines to verify correct version is deployed
   */
  fastify.get(
    '/version',
    {
      schema: {
        description: 'Application version and build info endpoint. No auth required.',
        tags: ['meta'],
        response: {
          200: {
            type: 'object',
            properties: {
              version: { type: 'string', example: '0.2.0' },
              name: { type: 'string', example: 'akis-backend' },
              commit: { type: 'string', example: 'abc1234' },
              buildTime: { type: 'string', example: '2026-01-09T12:00:00.000Z' },
              environment: { type: 'string', example: 'production' },
              startTime: { type: 'string', example: '2026-01-09T12:00:00.000Z' },
            },
          },
        },
      },
    },
    async () => {
      return {
        ...BUILD_INFO,
        startTime: START_TIME,
      };
    }
  );
}

