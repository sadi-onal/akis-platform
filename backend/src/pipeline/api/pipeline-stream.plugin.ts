/**
 * Pipeline SSE stream plugin — provides real-time activity updates.
 * Mounted alongside the main pipeline plugin at /api/pipelines prefix.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'http';
import { pipelineBus, type PipelineActivity } from '../core/activityEmitter.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';

export interface PipelineStreamPluginOptions {
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
  orchestrator?: PipelineOrchestrator;
}

export async function pipelineStreamPlugin(
  fastify: FastifyInstance,
  opts: PipelineStreamPluginOptions,
) {
  const isDevMode = process.env.DEV_MODE === 'true';

  const authPreHandler = async (request: FastifyRequest) => {
    if (isDevMode && opts.devUserId) {
      (request as unknown as Record<string, unknown>).__pipelineUserId = opts.devUserId;
      return;
    }
    await opts.requireAuth(request);
  };

  // GET /api/pipelines/:id/stream — SSE endpoint
  fastify.get('/:id/stream', { preHandler: authPreHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request as unknown as Record<string, unknown>).__pipelineUserId as string;

    // Ownership check — prevent IDOR on SSE streams
    if (opts.orchestrator && userId) {
      try {
        const p = await opts.orchestrator.getStatus(id);
        if (p.userId !== userId) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }
    }

    const raw = reply as unknown as { raw: ServerResponse };
    const reqRaw = request as unknown as { raw: IncomingMessage };

    raw.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial connected event
    raw.raw.write(
      `data: ${JSON.stringify({ type: 'connected', pipelineId: id })}\n\n`,
    );

    let cleaned = false;
    let paused = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pipelineBus.off(`pipeline:${id}`, onActivity);
      clearInterval(heartbeat);
      clearTimeout(maxAge);
    };

    const onActivity = (activity: PipelineActivity) => {
      if (paused) return; // backpressure — skip while buffer is full
      try {
        const ok = raw.raw.write(`data: ${JSON.stringify(activity)}\n\n`);
        if (!ok) {
          paused = true;
          raw.raw.once('drain', () => { paused = false; });
        }
      } catch {
        // Client disconnected — clean up listener + timers
        cleanup();
      }
    };

    pipelineBus.on(`pipeline:${id}`, onActivity);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      if (paused) return; // skip heartbeat while backpressured
      try {
        const ok = raw.raw.write(`: heartbeat\n\n`);
        if (!ok) {
          paused = true;
          raw.raw.once('drain', () => { paused = false; });
        }
      } catch {
        cleanup();
      }
    }, 15000);

    // Max connection age: force-close after 30 min to prevent zombie connections
    const maxAge = setTimeout(() => {
      cleanup();
      try { raw.raw.end(); } catch { /* already closed */ }
    }, 30 * 60 * 1000);

    reqRaw.raw.on('close', cleanup);

    // Tell Fastify we're handling the response ourselves
    reply.hijack();
  });
}
