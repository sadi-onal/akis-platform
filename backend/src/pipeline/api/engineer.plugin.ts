/**
 * Engineer Rental Mode Fastify plugin — mounts all /api/engineer routes.
 * Follows the pattern from dev-session.plugin.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createEngineerRoutes } from './engineer.routes.js';

export interface EngineerPluginOptions {
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
  // TODO: Inject TaskDiscoveryService and SessionManager when available
}

export async function engineerPlugin(
  fastify: FastifyInstance,
  opts: EngineerPluginOptions,
) {
  const { requireAuth, devUserId } = opts;
  const isDevMode = process.env.DEV_MODE === 'true';

  const routes = createEngineerRoutes({
    getUserId: (request: unknown) => {
      return ((request as Record<string, unknown>).__engineerUserId as string) ?? '';
    },
  });

  // Auth preHandler — dev mode bypass or real auth
  const authPreHandler = async (request: FastifyRequest) => {
    if (isDevMode && devUserId) {
      (request as unknown as Record<string, unknown>).__engineerUserId = devUserId;
      return;
    }
    const user = await requireAuth(request);
    (request as unknown as Record<string, unknown>).__engineerUserId = user.id;
  };

  // Error handler scoped to this plugin
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: `ENGINEER_${statusCode}`, message: error.message },
        requestId: request.id,
      });
    }
    // Delegate to parent error handler
    throw error;
  });

  // ─── Task Discovery ────────────────────────────────
  // POST /api/engineer/discover
  fastify.post('/discover', { preHandler: authPreHandler }, async (request) => {
    return routes.discover(request);
  });

  // ─── Session CRUD ──────────────────────────────────
  // POST /api/engineer/session
  fastify.post('/session', { preHandler: authPreHandler }, async (request) => {
    const result = await routes.createSession(request);
    return result;
  });

  // POST /api/engineer/session/:id/start
  fastify.post('/session/:id/start', { preHandler: authPreHandler }, async (request) => {
    return routes.startSession(request);
  });

  // GET /api/engineer/session/:id
  fastify.get('/session/:id', { preHandler: authPreHandler }, async (request) => {
    return routes.getSession(request);
  });

  // GET /api/engineer/session/:id/progress
  fastify.get('/session/:id/progress', { preHandler: authPreHandler }, async (request) => {
    return routes.getProgress(request);
  });

  // POST /api/engineer/session/:id/pause
  fastify.post('/session/:id/pause', { preHandler: authPreHandler }, async (request) => {
    return routes.pauseSession(request);
  });

  // POST /api/engineer/session/:id/resume
  fastify.post('/session/:id/resume', { preHandler: authPreHandler }, async (request) => {
    return routes.resumeSession(request);
  });

  // POST /api/engineer/session/:id/cancel
  fastify.post('/session/:id/cancel', { preHandler: authPreHandler }, async (request) => {
    return routes.cancelSession(request);
  });

  // GET /api/engineer/session/:id/report
  fastify.get('/session/:id/report', { preHandler: authPreHandler }, async (request) => {
    return routes.getReport(request);
  });
}
