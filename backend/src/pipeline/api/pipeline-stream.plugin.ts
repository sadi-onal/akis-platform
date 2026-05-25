/**
 * Pipeline SSE stream plugin — provides real-time activity updates.
 * Mounted alongside the main pipeline plugin at /api/pipelines prefix.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'http';
import { pipelineBus, type PipelineActivity } from '../core/activityEmitter.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';
import { isDevMode } from '../../config/devMode.js';

export interface PipelineStreamPluginOptions {
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
  orchestrator?: PipelineOrchestrator;
}

export async function pipelineStreamPlugin(
  fastify: FastifyInstance,
  opts: PipelineStreamPluginOptions,
) {
  const isDevModeActive = isDevMode();

  const authPreHandler = async (request: FastifyRequest) => {
    try {
      const user = await opts.requireAuth(request);
      (request as unknown as Record<string, unknown>).__pipelineUserId = user.id;
      return;
    } catch {
      if (isDevModeActive && opts.devUserId) {
        (request as unknown as Record<string, unknown>).__pipelineUserId = opts.devUserId;
        return;
      }
      throw Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
    }
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
    // #628: queue activities during backpressure instead of dropping them.
    // Iterate loops generate many activities in rapid succession; the old
    // `if (paused) return` silently discarded events, leaving the frontend
    // with holes that made cinema columns appear empty. The queue is
    // bounded (100 items) to avoid unbounded memory growth on very slow
    // clients — if the client can't keep up even after draining, the
    // oldest queued events are dropped (they're still in the DB for
    // hydration on reconnect).
    const BACKPRESSURE_QUEUE_LIMIT = 100;
    const backpressureQueue: PipelineActivity[] = [];
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pipelineBus.off(`pipeline:${id}`, onActivity);
      clearInterval(heartbeat);
      clearTimeout(maxAge);
      backpressureQueue.length = 0;
    };

    const flushQueue = () => {
      while (backpressureQueue.length > 0 && !paused && !cleaned) {
        const queued = backpressureQueue.shift()!;
        try {
          const ok = raw.raw.write(`data: ${JSON.stringify(queued)}\n\n`);
          if (!ok) {
            paused = true;
            raw.raw.once('drain', () => {
              paused = false;
              flushQueue();
            });
            return;
          }
        } catch {
          cleanup();
          return;
        }
      }
    };

    const onActivity = (activity: PipelineActivity) => {
      if (cleaned) return;
      if (paused) {
        // Queue instead of dropping — #628
        if (backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
          backpressureQueue.shift(); // drop oldest to stay bounded
        }
        backpressureQueue.push(activity);
        return;
      }
      try {
        const ok = raw.raw.write(`data: ${JSON.stringify(activity)}\n\n`);
        if (!ok) {
          paused = true;
          raw.raw.once('drain', () => {
            paused = false;
            flushQueue();
          });
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
