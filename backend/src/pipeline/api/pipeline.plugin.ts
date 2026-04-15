/**
 * Pipeline Fastify plugin — mounts all /api/pipelines routes.
 * Bridges the pipeline orchestrator to the main Fastify server.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createPipelineRoutes } from './pipeline.routes.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';
import { PipelineNotFoundError, InvalidStageError, GitHubAPIError } from '../core/contracts/PipelineErrors.js';
import { StaleStateError } from '../db/DrizzlePipelineStore.js';
import { ZodError } from 'zod';
import { FileUploadService, type ProcessedAttachment } from '../services/FileUploadService.js';
import { logger } from '../../lib/logger.js';

// ─── AKIS Platform Repo Guard ────────────────────
const BLOCKED_PLATFORM_REPOS = [
  'akis-platform',
  'akis-platform-development',
];

function isBlockedPlatformRepo(repoName: string): boolean {
  const name = repoName.trim().toLowerCase();
  return BLOCKED_PLATFORM_REPOS.some((blocked) => name.includes(blocked));
}

export interface PipelinePluginOptions {
  orchestrator: PipelineOrchestrator;
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
}

/**
 * Parse a potentially multipart request, extracting fields and file attachments.
 * Falls back to standard JSON body when request is not multipart.
 */
async function parseMultipartRequest(
  request: FastifyRequest,
  fileUploadService: FileUploadService,
): Promise<{ fields: Record<string, unknown>; attachments: ProcessedAttachment[]; attachmentContext?: string }> {
  if (!request.isMultipart()) {
    return {
      fields: (request.body ?? {}) as Record<string, unknown>,
      attachments: [],
      attachmentContext: undefined,
    };
  }

  const fields: Record<string, unknown> = {};
  const attachments: ProcessedAttachment[] = [];

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      if (!part.filename) continue;
      try {
        const processed = await fileUploadService.processMultipartFile(part);
        attachments.push(processed);
      } catch (err) {
        logger.warn({ err, file: part.filename }, '[Pipeline] Dosya işleme hatası');
        throw err;
      }
    } else {
      // Field — try JSON parse for structured values
      const value = part.value as string;
      try {
        fields[part.fieldname] = JSON.parse(value);
      } catch {
        fields[part.fieldname] = value;
      }
    }
  }

  fileUploadService.validateFileCount(attachments.length);

  const attachmentContext = attachments.length > 0
    ? fileUploadService.buildContextString(attachments)
    : undefined;

  return { fields, attachments, attachmentContext };
}

export async function pipelinePlugin(
  fastify: FastifyInstance,
  opts: PipelinePluginOptions,
) {
  const { orchestrator, requireAuth, devUserId } = opts;
  const isDevMode = process.env.DEV_MODE === 'true';
  const fileUploadService = new FileUploadService();

  const routes = createPipelineRoutes({
    orchestrator,
    getUserId: (request: unknown) => {
      return ((request as Record<string, unknown>).__pipelineUserId as string) ?? '';
    },
  });

  // Auth preHandler — dev mode bypass or real auth
  const authPreHandler = async (request: FastifyRequest) => {
    if (isDevMode && devUserId) {
      (request as unknown as Record<string, unknown>).__pipelineUserId = devUserId;
      return;
    }
    const user = await requireAuth(request);
    (request as unknown as Record<string, unknown>).__pipelineUserId = user.id;
  };

  // Ownership preHandler — verify user owns the pipeline (prevents IDOR)
  const ownershipPreHandler = async (request: FastifyRequest) => {
    const userId = (request as unknown as Record<string, unknown>).__pipelineUserId as string;
    const { id } = request.params as { id: string };
    if (!id || !userId) return;
    const pipeline = await orchestrator.getStatus(id);
    if (pipeline.userId !== userId) {
      throw new Error('UNAUTHORIZED');
    }
  };

  // Pipeline-scoped error handler: catches ZodError from pipeline's own zod module
  // (backend global handler uses a different zod instance due to pnpm hoisting)
  // Also catches orchestrator domain errors (invalid stage, not found) as 4xx
  fastify.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.errors,
        },
        requestId: request.id,
      });
    }

    // Typed domain errors — instanceof checks (preferred over string matching)
    if (error instanceof PipelineNotFoundError) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: error.message },
        requestId: request.id,
      });
    }
    if (error instanceof InvalidStageError) {
      return reply.code(400).send({
        error: { code: 'INVALID_STAGE', message: error.message },
        requestId: request.id,
      });
    }
    if (error instanceof StaleStateError) {
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: 'Pipeline state changed concurrently. Please refresh and retry.' },
        requestId: request.id,
      });
    }
    if (error instanceof GitHubAPIError) {
      return reply.code(502).send({
        error: { code: 'GITHUB_API_ERROR', message: error.message },
        requestId: request.id,
      });
    }

    // Fallback string matching for legacy errors
    const msg = error.message ?? '';
    if (msg.startsWith('Cannot skip') || msg.startsWith('Cannot retry')) {
      return reply.code(400).send({
        error: { code: 'INVALID_STAGE', message: msg },
        requestId: request.id,
      });
    }

    // Auth errors — 401 Unauthorized
    if (error.message === 'UNAUTHORIZED') {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        requestId: request.id,
      });
    }

    // Delegate to parent (global) error handler
    throw error;
  });

  // POST /api/pipelines — start new pipeline (rate-limited: 5/min per user)
  // Supports both JSON and multipart/form-data (with file attachments)
  fastify.post('/', { preHandler: authPreHandler, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { fields, attachmentContext } = await parseMultipartRequest(request, fileUploadService);
    // Inject parsed fields as body so downstream route handler can parse them
    (request as unknown as { body: unknown }).body = fields;
    const result = await routes.startPipeline(request, reply, attachmentContext);
    return reply.code(201).send(result);
  });

  // GET /api/pipelines — list user's pipelines
  fastify.get('/', { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    return routes.listPipelines(request);
  });

  // GET /api/pipelines/:id — get pipeline status
  fastify.get('/:id', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.getStatus(request);
  });

  // GET /api/pipelines/:id/activities — replay buffered activities for state recovery
  fastify.get('/:id/activities', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.getActivities(request);
  });

  // POST /api/pipelines/:id/message — send message to Scribe
  // Supports both JSON and multipart/form-data (with file attachments)
  fastify.post('/:id/message', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    const { fields, attachmentContext } = await parseMultipartRequest(request, fileUploadService);
    (request as unknown as { body: unknown }).body = fields;
    return routes.sendMessage(request, attachmentContext);
  });

  // POST /api/pipelines/:id/approve — approve spec
  fastify.post('/:id/approve', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request as unknown as { body: Record<string, unknown> }).body;
    const repoName = typeof body?.repoName === 'string' ? body.repoName.trim() : '';
    if (isBlockedPlatformRepo(repoName)) {
      return reply.code(400).send({
        error: {
          code: 'BLOCKED_TARGET_REPO',
          message: 'AKIS platform reposuna pipeline çıktısı gönderilemez. Farklı bir hedef repo belirtin.',
        },
        requestId: request.id,
      });
    }
    return routes.approveSpec(request);
  });

  // POST /api/pipelines/:id/reject — reject spec
  fastify.post('/:id/reject', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.rejectSpec(request);
  });

  // POST /api/pipelines/:id/retry — retry failed stage
  fastify.post('/:id/retry', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.retryStage(request);
  });

  // POST /api/pipelines/:id/skip-trace — skip trace
  fastify.post('/:id/skip-trace', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.skipTrace(request);
  });

  // PATCH /api/pipelines/:id/title — rename pipeline
  fastify.route({
    method: 'PATCH',
    url: '/:id/title',
    preHandler: [authPreHandler, ownershipPreHandler],
    handler: async (request: FastifyRequest) => {
      return routes.updateTitle(request);
    },
  });

  // PATCH /api/pipelines/:id/trace-toggle — toggle trace enabled/disabled
  fastify.route({
    method: 'PATCH',
    url: '/:id/trace-toggle',
    preHandler: [authPreHandler, ownershipPreHandler],
    handler: async (request: FastifyRequest) => {
      return routes.toggleTrace(request);
    },
  });

  // DELETE /api/pipelines/:id — cancel pipeline
  fastify.route({
    method: 'DELETE',
    url: '/:id',
    preHandler: [authPreHandler, ownershipPreHandler],
    handler: async (request: FastifyRequest) => {
      return routes.cancelPipeline(request);
    },
  });

  // GET /api/pipelines/:id/metrics — get pipeline run metrics (Level 3)
  fastify.get('/:id/metrics', { preHandler: [authPreHandler, ownershipPreHandler] }, async (request: FastifyRequest) => {
    return routes.getMetrics(request);
  });

  // GET /api/pipelines/:id/files-all — get all file contents for StackBlitz embed
  fastify.get('/:id/files-all', { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    return routes.getAllFiles(request);
  });

  // GET /api/pipelines/:id/files/* — get file content from stored pipeline data
  fastify.get('/:id/files/*', { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    return routes.getFileContent(request);
  });
}
