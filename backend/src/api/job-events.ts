import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobEventBus, type StreamEvent } from '../core/events/JobEventBus.js';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../utils/auth.js';

const TERMINAL_STATES = new Set(['completed', 'failed']);
const streamQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  includeHistory: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      if (value === undefined) return true;
      return value !== 'false';
    }),
});

function extractJobUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawUserId = (payload as Record<string, unknown>).userId;
  if (typeof rawUserId !== 'string') return null;
  const normalizedUserId = rawUserId.trim();
  return normalizedUserId.length > 0 ? normalizedUserId : null;
}

export async function jobEventsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/api/agents/jobs/:id/stream',
    {
      schema: {
        description: 'SSE stream for job progress events',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'integer', minimum: 1 },
            includeHistory: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const { id } = request.params as { id: string };
        const query = streamQuerySchema.parse(request.query);
        const includeHistory = query.includeHistory ?? true;

        const [job] = await db.select({ state: jobs.state, payload: jobs.payload }).from(jobs).where(eq(jobs.id, id)).limit(1);
        if (!job) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }
        const jobUserId = extractJobUserId(job.payload);
        if (jobUserId !== user.id) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }

      // Access raw Node.js response for SSE
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (event: StreamEvent) => {
        raw.write(jobEventBus.formatForSSE(event));
      };

      if (query.cursor) {
        const events = jobEventBus.getStreamHistoryAfter(id, query.cursor);
        for (const event of events) sendEvent(event);
      } else if (includeHistory) {
        const events = jobEventBus.getStreamHistory(id);
        for (const event of events) sendEvent(event);
      }

      if (TERMINAL_STATES.has(job.state)) {
        sendEvent({
          eventId: jobEventBus.getCurrentEventId(id) + 1,
          type: 'stage',
          ts: new Date().toISOString(),
          jobId: id,
          stage: job.state === 'completed' ? 'completed' : 'failed',
          status: 'completed',
          message: `Job ${job.state}`,
        });
        raw.end();
        return;
      }

      const onEvent = (event: StreamEvent) => {
        sendEvent(event);
        if (event.type === 'stage' && (event.stage === 'completed' || event.stage === 'failed') && event.status === 'completed') {
          cleanup();
        }
      };

      const keepAlive = setInterval(() => {
        raw.write(': keepalive\n\n');
      }, 15_000);

      const cleanup = () => {
        clearInterval(keepAlive);
        jobEventBus.unsubscribeStream(id, onEvent);
        raw.end();
      };

      jobEventBus.subscribeStream(id, onEvent);

      request.raw.on('close', cleanup);
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw error;
      }
    }
  );
}
