/**
 * Engineer Rental Mode Fastify plugin — mounts all /api/engineer routes.
 * Wires TaskDiscoveryService + SessionManager into route handlers.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createEngineerRoutes } from './engineer.routes.js';
import { TaskDiscoveryService } from '../core/task-discovery/index.js';
import { SessionManager, SessionNotFoundError } from '../core/session/index.js';
import {
  EngineerSessionRunner,
  type EngineerSessionOrchestrator,
} from '../core/session/EngineerSessionRunner.js';
import type { EngineerSession, SelectedTask } from '../core/session/SessionTypes.js';
import type { ScribeInput } from '../core/contracts/PipelineTypes.js';
import type { AIServiceLike, GitHubServiceLike } from '../core/pipeline-factory.js';

/**
 * Default mapping from an engineer session task to a ScribeInput. Exported
 * so tests can exercise the description-vs-title precedence rules without
 * standing up a Fastify instance.
 */
export function defaultTaskToScribeInput(
  task: SelectedTask,
  session: EngineerSession,
): ScribeInput {
  // Prefer the full description when available — a one-line title rarely
  // carries enough signal for Scribe to write a quality spec.
  const idea = task.description?.trim()
    ? `${task.title}\n\n${task.description}`
    : task.title;
  return {
    idea,
    context: task.category ? `Category: ${task.category}` : undefined,
    targetStack: 'typescript',
    existingRepo: {
      owner: session.owner,
      repo: session.repo,
      branch: 'main',
    },
  };
}

export interface EngineerPluginOptions {
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
  aiService: AIServiceLike;
  githubService: GitHubServiceLike;
  /**
   * Pipeline orchestrator — required for running actual Scribe→Proto→Trace
   * pipelines per engineer task. Optional for unit/smoke tests that only
   * exercise HTTP shape.
   */
  orchestrator?: EngineerSessionOrchestrator;
}

export async function engineerPlugin(
  fastify: FastifyInstance,
  opts: EngineerPluginOptions,
) {
  const { requireAuth, devUserId, aiService, githubService, orchestrator } = opts;
  const isDevMode = process.env.DEV_MODE === 'true';

  // Create real service instances
  const taskDiscovery = new TaskDiscoveryService({ aiService });
  const sessionManager = new SessionManager();

  // Wire runner only when an orchestrator is available; without one the
  // routes still serve (session CRUD works) but /session/:id/start simply
  // won't kick off pipelines.
  const sessionRunner = orchestrator
    ? new EngineerSessionRunner({
        sessionManager,
        orchestrator,
        taskToScribeInput: defaultTaskToScribeInput,
      })
    : undefined;

  const routes = createEngineerRoutes({
    getUserId: (request: unknown) => {
      return ((request as Record<string, unknown>).__engineerUserId as string) ?? '';
    },
    taskDiscovery,
    sessionManager,
    githubService,
    sessionRunner,
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
    if (error instanceof SessionNotFoundError) {
      return reply.code(404).send({
        error: { code: 'SESSION_NOT_FOUND', message: error.message },
        requestId: request.id,
      });
    }
    // Delegate to parent error handler
    throw error;
  });

  // ─── Task Discovery ────────────────────────────────
  fastify.post('/discover', { preHandler: authPreHandler }, async (request) => {
    return routes.discover(request);
  });

  // ─── Session CRUD ──────────────────────────────────
  fastify.post('/session', { preHandler: authPreHandler }, async (request) => {
    return routes.createSession(request);
  });

  fastify.post('/session/:id/start', { preHandler: authPreHandler }, async (request) => {
    return routes.startSession(request);
  });

  fastify.get('/session/:id', { preHandler: authPreHandler }, async (request) => {
    return routes.getSession(request);
  });

  fastify.get('/session/:id/progress', { preHandler: authPreHandler }, async (request) => {
    return routes.getProgress(request);
  });

  fastify.post('/session/:id/pause', { preHandler: authPreHandler }, async (request) => {
    return routes.pauseSession(request);
  });

  fastify.post('/session/:id/resume', { preHandler: authPreHandler }, async (request) => {
    return routes.resumeSession(request);
  });

  fastify.post('/session/:id/cancel', { preHandler: authPreHandler }, async (request) => {
    return routes.cancelSession(request);
  });

  fastify.get('/session/:id/report', { preHandler: authPreHandler }, async (request) => {
    return routes.getReport(request);
  });
}
