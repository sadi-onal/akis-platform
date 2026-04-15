import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requireAuth } from '../utils/auth.js';
import { CrewRunManager } from '../core/crew/CrewRunManager.js';
import { CrewEventEmitter } from '../core/crew/CrewEventEmitter.js';
import { crewRunInputSchema } from '../core/crew/types.js';
import { formatErrorResponse, getStatusCodeForError } from '../utils/errorHandler.js';

// Singleton event emitter (shared across requests)
const crewEventEmitter = new CrewEventEmitter();

// CrewRunManager will be initialized with a submitJob function
let crewRunManager: CrewRunManager | null = null;

export function initCrewRunManager(submitJobFn: (payload: Record<string, unknown>) => Promise<{ id: string }>) {
  crewRunManager = new CrewRunManager(db as never, submitJobFn, crewEventEmitter);
}

export function getCrewRunManager(): CrewRunManager | null {
  return crewRunManager;
}

export function getCrewEventEmitter(): CrewEventEmitter {
  return crewEventEmitter;
}

export async function crewRoutes(fastify: FastifyInstance) {

  // ─── Start Crew Run ─────────────────────────────────────────
  fastify.post('/api/agents/crew', async (request, reply) => {
    const user = await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const input = crewRunInputSchema.parse(request.body);
      const crewRunId = await crewRunManager.startCrewRun(user.id, input);
      const crewRun = await crewRunManager.getCrewRunWithWorkers(crewRunId);
      return reply.code(201).send({ data: crewRun });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'Invalid crew run input',
          details: err.errors,
        });
      }
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── List Crew Runs ─────────────────────────────────────────
  fastify.get('/api/agents/crew', async (request, reply) => {
    const user = await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const runs = await crewRunManager.getUserCrewRuns(user.id);
      return reply.send({ data: runs });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Get Crew Run Detail ────────────────────────────────────
  fastify.get('/api/agents/crew/:id', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id } = request.params as { id: string };
      const crewRun = await crewRunManager.getCrewRunWithWorkers(id);
      if (!crewRun) {
        return reply.code(404).send({ error: 'Crew run not found' });
      }
      return reply.send({ data: crewRun });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Crew Run SSE Stream ────────────────────────────────────
  fastify.get('/api/agents/crew/:id/stream', async (request, reply) => {
    await requireAuth(request);
    const { id: crewRunId } = request.params as { id: string };
    const { cursor } = request.query as { cursor?: string };

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send catch-up events
    const history = cursor
      ? crewEventEmitter.getHistoryAfter(crewRunId, cursor)
      : crewEventEmitter.getHistory(crewRunId);

    for (const event of history) {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    // Subscribe to new events
    const unsubscribe = crewEventEmitter.subscribe(crewRunId, (event) => {
      try {
        raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsubscribe();
      }
    });

    // Keep-alive ping every 15s
    const keepAlive = setInterval(() => {
      try {
        raw.write(':ping\n\n');
      } catch {
        clearInterval(keepAlive);
        unsubscribe();
      }
    }, 15000);

    // Cleanup on close
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ─── Send Message to Worker ─────────────────────────────────
  fastify.post('/api/agents/crew/:id/messages', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id: crewRunId } = request.params as { id: string };
      const schema = z.object({
        toJobId: z.string().uuid(),
        content: z.string().min(1),
      });
      const { toJobId, content } = schema.parse(request.body);

      const mailbox = crewRunManager.getMailbox();
      const message = await mailbox.sendUserMessage(crewRunId, toJobId, content);

      return reply.code(201).send({ data: message });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid message', details: err.errors });
      }
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Broadcast Message to All Workers ───────────────────────
  fastify.post('/api/agents/crew/:id/broadcast', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id: crewRunId } = request.params as { id: string };
      const schema = z.object({ content: z.string().min(1) });
      const { content } = schema.parse(request.body);

      const mailbox = crewRunManager.getMailbox();
      const message = await mailbox.broadcast(
        crewRunId,
        { jobId: null, role: 'user' },
        content,
      );

      return reply.code(201).send({ data: message });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Get Messages ───────────────────────────────────────────
  fastify.get('/api/agents/crew/:id/messages', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id: crewRunId } = request.params as { id: string };
      const { limit, forJobId } = request.query as { limit?: string; forJobId?: string };

      const mailbox = crewRunManager.getMailbox();
      const messages = await mailbox.getMessages(crewRunId, {
        limit: limit ? parseInt(limit) : 100,
        forJobId,
      });

      return reply.send({ data: messages });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Get Task Board ─────────────────────────────────────────
  fastify.get('/api/agents/crew/:id/tasks', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id: crewRunId } = request.params as { id: string };
      const taskBoard = crewRunManager.getTaskBoard();
      const tasks = await taskBoard.getAllTasks(crewRunId);
      return reply.send({ data: tasks });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });

  // ─── Cancel Crew Run ────────────────────────────────────────
  fastify.post('/api/agents/crew/:id/cancel', async (request, reply) => {
    await requireAuth(request);
    if (!crewRunManager) {
      return reply.code(503).send({ error: 'Crew system not initialized' });
    }

    try {
      const { id: crewRunId } = request.params as { id: string };
      await crewRunManager.cancelCrewRun(crewRunId);
      return reply.send({ data: { cancelled: true } });
    } catch (err) {
      const errorResponse = formatErrorResponse(request, err);
      const statusCode = getStatusCodeForError(errorResponse.error.code);
      return reply.code(statusCode).send(errorResponse);
    }
  });
}
