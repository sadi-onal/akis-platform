import { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  conversationMessages,
  conversationThreads,
  jobs,
  planCandidateBuilds,
  planCandidates,
  threadTasks,
  threadTrustSnapshots,
} from '../db/schema.js';
import { requireAuth } from '../utils/auth.js';
import { conversationEventBus } from '../core/events/ConversationEventBus.js';
import type { ConversationStreamEvent } from '../core/events/ConversationEventBus.js';

const MAX_ACTIVE_RUNS_PER_USER = 3;

const threadIdParamsSchema = z.object({
  threadId: z.string().uuid(),
});

const createThreadSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
});

const createMessageSchema = z.object({
  role: z.enum(['system', 'user', 'agent']),
  content: z.string().trim().min(1),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().optional(),
});

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

const generatePlansSchema = z.object({
  prompt: z.string().trim().min(1),
  count: z.coerce.number().int().min(1).max(3).optional(),
  sourceMessageId: z.string().uuid().optional(),
});

const planIdParamsSchema = z.object({
  threadId: z.string().uuid(),
  planId: z.string().uuid(),
});

const generateAlternativesSchema = z.object({
  count: z.coerce.number().int().min(1).max(2).optional(),
});

const buildPlanSchema = z.object({
  planId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});

const taskIdParamsSchema = z.object({
  taskId: z.string().uuid(),
});

const taskRespondSchema = z.object({
  answer: z.string().trim().min(1),
});

const trustSnapshotSchema = z.object({
  jobId: z.string().uuid().optional(),
  reliability: z.number().int().min(0).max(100),
  hallucinationRisk: z.number().int().min(0).max(100),
  taskSuccess: z.number().int().min(0).max(100),
  toolHealth: z.number().int().min(0).max(100),
  metadata: z.record(z.unknown()).optional(),
});

const listTrustSnapshotQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function deriveTitleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  const trimmed = clean.slice(0, 80);
  return trimmed.length < clean.length ? `${trimmed}…` : trimmed;
}

async function getThreadForUser(userId: string, threadId: string) {
  return db.query.conversationThreads.findFirst({
    where: and(eq(conversationThreads.id, threadId), eq(conversationThreads.userId, userId)),
  });
}

function toThreadDto(
  thread: typeof conversationThreads.$inferSelect,
  opts?: {
    lastMessagePreview?: string | null;
    lastMessageRole?: string | null;
    messageCount?: number;
  }
) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    agentType: thread.agentType,
    activeRuns: thread.activeRuns,
    lastMessageAt: thread.lastMessageAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastMessagePreview: opts?.lastMessagePreview ?? null,
    lastMessageRole: opts?.lastMessageRole ?? null,
    messageCount: opts?.messageCount ?? 0,
  };
}

function toMessageDto(message: typeof conversationMessages.$inferSelect) {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    agentType: message.agentType,
    content: message.content,
    metadata: message.metadata ?? {},
    createdAt: message.createdAt,
  };
}

function toPlanCandidateDto(candidate: typeof planCandidates.$inferSelect) {
  return {
    id: candidate.id,
    threadId: candidate.threadId,
    sourceMessageId: candidate.sourceMessageId,
    title: candidate.title,
    summary: candidate.summary,
    sourcePrompt: candidate.sourcePrompt,
    status: candidate.status,
    selected: candidate.selected,
    buildJobId: candidate.buildJobId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export async function conversationsRoutes(fastify: FastifyInstance) {
  fastify.post('/api/conversations/threads', async (request, reply) => {
    const body = createThreadSchema.parse(request.body ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const now = new Date();
    const [thread] = await db
      .insert(conversationThreads)
      .values({
        ...(body.id ? { id: body.id } : {}),
        userId,
        title: body.title?.trim() || 'New conversation',
        agentType: body.agentType ?? 'scribe',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    conversationEventBus.emitEvent(thread.id, 'thread', {
      action: 'created',
      title: thread.title,
      status: thread.status,
    });

    return reply.code(201).send({ thread: toThreadDto(thread) });
  });

  fastify.get('/api/conversations/threads', async (request, reply) => {
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const threads = await db.query.conversationThreads.findMany({
      where: eq(conversationThreads.userId, userId),
      orderBy: [desc(conversationThreads.updatedAt)],
      limit: 100,
    });

    const enriched = await Promise.all(
      threads.map(async (thread) => {
        const [lastMessage] = await db
          .select({
            content: conversationMessages.content,
            role: conversationMessages.role,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.threadId, thread.id))
          .orderBy(desc(conversationMessages.createdAt))
          .limit(1);

        const [counts] = await db
          .select({
            count: sql<number>`count(*)`,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.threadId, thread.id));

        return toThreadDto(thread, {
          lastMessagePreview: lastMessage?.content ?? null,
          lastMessageRole: lastMessage?.role ?? null,
          messageCount: Number(counts?.count ?? 0),
        });
      })
    );

    return { threads: enriched };
  });

  fastify.get('/api/conversations/threads/:threadId', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    return { thread: toThreadDto(thread) };
  });

  fastify.post('/api/conversations/threads/:threadId/messages', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const body = createMessageSchema.parse(request.body ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const now = new Date();
    const [message] = await db
      .insert(conversationMessages)
      .values({
        threadId,
        userId,
        role: body.role,
        agentType: body.agentType ?? thread.agentType,
        content: body.content.trim(),
        metadata: body.metadata ?? {},
        createdAt: now,
      })
      .returning();

    const patch: Partial<typeof conversationThreads.$inferInsert> = {
      updatedAt: now,
      lastMessageAt: now,
    };
    if (thread.title === 'New conversation' && body.role === 'user') {
      patch.title = deriveTitleFromPrompt(body.content);
    }

    await db
      .update(conversationThreads)
      .set(patch)
      .where(eq(conversationThreads.id, threadId));

    conversationEventBus.emitEvent(threadId, 'message', {
      action: 'created',
      role: message.role,
      messageId: message.id,
    });

    return reply.code(201).send({ message: toMessageDto(message) });
  });

  fastify.get('/api/conversations/threads/:threadId/messages', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const query = listMessagesQuerySchema.parse(request.query ?? {});
    const beforeDate = query.before ? new Date(query.before) : null;
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const predicates = [eq(conversationMessages.threadId, threadId)];
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) {
      predicates.push(lt(conversationMessages.createdAt, beforeDate));
    }

    const rows = await db
      .select()
      .from(conversationMessages)
      .where(and(...predicates))
      .orderBy(asc(conversationMessages.createdAt))
      .limit(query.limit);

    return { messages: rows.map(toMessageDto) };
  });

  fastify.get('/api/conversations/threads/:threadId/plans', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const candidates = await db.query.planCandidates.findMany({
      where: and(eq(planCandidates.threadId, threadId), eq(planCandidates.userId, userId)),
      orderBy: [asc(planCandidates.createdAt)],
    });

    return { candidates: candidates.map(toPlanCandidateDto) };
  });

  fastify.post('/api/conversations/threads/:threadId/plans/generate', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const body = generatePlansSchema.parse(request.body ?? {});
    const count = body.count ?? 1;
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const now = Date.now();
    const variants = ['Balanced scope', 'Speed-first', 'Safety-first'];
    const rows = Array.from({ length: count }).map((_, index) => ({
      threadId,
      userId,
      sourceMessageId: body.sourceMessageId,
      title: `Plan ${index + 1}`,
      summary: variants[index] ?? `Alternative ${index + 1}`,
      sourcePrompt: body.prompt.trim(),
      status: 'unbuilt' as const,
      selected: index === 0,
      createdAt: new Date(now + index),
      updatedAt: new Date(now + index),
    }));

    const inserted = await db.insert(planCandidates).values(rows).returning();
    await db
      .update(conversationThreads)
      .set({
        status: 'awaiting_plan_selection',
        updatedAt: new Date(),
      })
      .where(eq(conversationThreads.id, threadId));

    conversationEventBus.emitEvent(threadId, 'plan', {
      action: 'generated',
      count: inserted.length,
    });

    return reply.code(201).send({
      candidates: inserted.map(toPlanCandidateDto),
    });
  });

  fastify.post('/api/conversations/threads/:threadId/plans/:planId/generate-alternatives', async (request, reply) => {
    const { threadId, planId } = planIdParamsSchema.parse(request.params);
    const body = generateAlternativesSchema.parse(request.body ?? {});
    const count = body.count ?? 2;
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const base = await db.query.planCandidates.findFirst({
      where: and(
        eq(planCandidates.id, planId),
        eq(planCandidates.threadId, threadId),
        eq(planCandidates.userId, userId)
      ),
    });
    if (!base) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Plan candidate not found' } });
    }

    const now = Date.now();
    const rows = Array.from({ length: count }).map((_, index) => ({
      threadId,
      userId,
      sourceMessageId: base.sourceMessageId,
      title: `${base.title} Alt ${index + 1}`,
      summary: `Alternative strategy ${index + 1}`,
      sourcePrompt: base.sourcePrompt,
      status: 'unbuilt' as const,
      selected: false,
      createdAt: new Date(now + index),
      updatedAt: new Date(now + index),
    }));

    const inserted = await db.insert(planCandidates).values(rows).returning();
    await db
      .update(conversationThreads)
      .set({
        status: 'awaiting_plan_selection',
        updatedAt: new Date(),
      })
      .where(eq(conversationThreads.id, threadId));

    conversationEventBus.emitEvent(threadId, 'plan', {
      action: 'alternatives_generated',
      count: inserted.length,
      basePlanId: planId,
    });

    return reply.code(201).send({
      candidates: inserted.map(toPlanCandidateDto),
    });
  });

  fastify.post('/api/conversations/threads/:threadId/plans/build', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const body = buildPlanSchema.parse(request.body ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const candidate = await db.query.planCandidates.findFirst({
      where: and(
        eq(planCandidates.id, body.planId),
        eq(planCandidates.threadId, threadId),
        eq(planCandidates.userId, userId)
      ),
    });
    if (!candidate) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Plan candidate not found' } });
    }
    if (candidate.status === 'built' || candidate.status === 'building') {
      return reply.code(409).send({
        error: {
          code: 'PLAN_ALREADY_BUILT',
          message: `Plan candidate is already ${candidate.status}`,
        },
      });
    }

    const [runningCountRow] = await db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(jobs)
      .where(
        and(
          inArray(jobs.state, ['pending', 'running']),
          sql`(${jobs.payload}->>'userId')::text = ${userId}`
        )
      );
    const activeRuns = Number(runningCountRow?.count ?? 0);

    if (activeRuns >= MAX_ACTIVE_RUNS_PER_USER) {
      const [queuedCandidate] = await db
        .update(planCandidates)
        .set({
          status: 'queued',
          selected: false,
          updatedAt: new Date(),
        })
        .where(eq(planCandidates.id, candidate.id))
        .returning();

      await db.insert(planCandidateBuilds).values({
        threadId,
        planCandidateId: candidate.id,
        userId,
        status: 'queued',
        jobId: body.jobId ?? null,
        metadata: { reason: 'ACTIVE_RUN_LIMIT' },
      });

      await db
        .update(conversationThreads)
        .set({
          status: 'queued',
          activeRuns: activeRuns,
          updatedAt: new Date(),
        })
        .where(eq(conversationThreads.id, threadId));

      conversationEventBus.emitEvent(threadId, 'plan', {
        action: 'queued',
        planId: candidate.id,
        activeRuns,
        limit: MAX_ACTIVE_RUNS_PER_USER,
      });

      return reply.code(200).send({
        status: 'queued',
        activeRuns,
        limit: MAX_ACTIVE_RUNS_PER_USER,
        candidate: toPlanCandidateDto(queuedCandidate),
      });
    }

    const nextStatus = body.jobId ? 'building' : 'built';
    const [updatedCandidate] = await db
      .update(planCandidates)
      .set({
        status: nextStatus,
        buildJobId: body.jobId ?? null,
        selected: false,
        updatedAt: new Date(),
      })
      .where(eq(planCandidates.id, candidate.id))
      .returning();

    await db.insert(planCandidateBuilds).values({
      threadId,
      planCandidateId: candidate.id,
      userId,
      status: nextStatus,
      jobId: body.jobId ?? null,
      metadata: body.jobId ? { mode: 'external_job_linked' } : { mode: 'direct_mark_built' },
    });

    await db
      .update(conversationThreads)
      .set({
        status: 'active',
        activeRuns: body.jobId ? activeRuns + 1 : activeRuns,
        updatedAt: new Date(),
      })
      .where(eq(conversationThreads.id, threadId));

    conversationEventBus.emitEvent(threadId, 'plan', {
      action: nextStatus,
      planId: candidate.id,
      jobId: body.jobId ?? null,
    });

    return reply.code(200).send({
      status: nextStatus,
      candidate: toPlanCandidateDto(updatedCandidate),
    });
  });

  fastify.post('/api/conversations/tasks/:taskId/respond', async (request, reply) => {
    const { taskId } = taskIdParamsSchema.parse(request.params);
    const body = taskRespondSchema.parse(request.body ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const task = await db.query.threadTasks.findFirst({
      where: and(eq(threadTasks.id, taskId), eq(threadTasks.userId, userId)),
    });
    if (!task) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Task not found' } });
    }

    const now = new Date();
    const [updatedTask] = await db
      .update(threadTasks)
      .set({
        status: 'answered',
        answer: body.answer.trim(),
        answeredAt: now,
        updatedAt: now,
      })
      .where(eq(threadTasks.id, task.id))
      .returning();

    const [message] = await db
      .insert(conversationMessages)
      .values({
        threadId: task.threadId,
        userId,
        role: 'user',
        content: body.answer.trim(),
        agentType: null,
        metadata: { source: 'task_response', taskId: task.id },
        createdAt: now,
      })
      .returning();

    await db
      .update(conversationThreads)
      .set({
        status: 'active',
        lastMessageAt: now,
        updatedAt: now,
      })
      .where(eq(conversationThreads.id, task.threadId));

    conversationEventBus.emitEvent(task.threadId, 'task', {
      action: 'answered',
      taskId: task.id,
      messageId: message.id,
    });

    return {
      task: {
        id: updatedTask.id,
        threadId: updatedTask.threadId,
        status: updatedTask.status,
        question: updatedTask.question,
        answer: updatedTask.answer,
        answeredAt: updatedTask.answeredAt,
      },
      message: toMessageDto(message),
    };
  });

  fastify.get('/api/conversations/threads/:threadId/trust-snapshots', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const query = listTrustSnapshotQuerySchema.parse(request.query ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const snapshots = await db.query.threadTrustSnapshots.findMany({
      where: and(eq(threadTrustSnapshots.threadId, threadId), eq(threadTrustSnapshots.userId, userId)),
      orderBy: [desc(threadTrustSnapshots.createdAt)],
      limit: query.limit,
    });
    return { snapshots };
  });

  fastify.post('/api/conversations/threads/:threadId/trust-snapshots', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const body = trustSnapshotSchema.parse(request.body ?? {});
    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const [snapshot] = await db
      .insert(threadTrustSnapshots)
      .values({
        threadId,
        userId,
        jobId: body.jobId ?? null,
        reliability: body.reliability,
        hallucinationRisk: body.hallucinationRisk,
        taskSuccess: body.taskSuccess,
        toolHealth: body.toolHealth,
        metadata: body.metadata ?? {},
      })
      .returning();

    conversationEventBus.emitEvent(threadId, 'trust', {
      action: 'snapshot_created',
      snapshotId: snapshot.id,
      reliability: snapshot.reliability,
      hallucinationRisk: snapshot.hallucinationRisk,
      taskSuccess: snapshot.taskSuccess,
      toolHealth: snapshot.toolHealth,
    });

    return reply.code(201).send({ snapshot });
  });

  fastify.get('/api/conversations/threads/:threadId/stream', async (request, reply) => {
    const { threadId } = threadIdParamsSchema.parse(request.params);
    const query = streamQuerySchema.parse(request.query ?? {});
    const includeHistory = query.includeHistory ?? true;

    let userId: string;
    try {
      const user = await requireAuth(request);
      userId = user.id;
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const thread = await getThreadForUser(userId, threadId);
    if (!thread) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: ConversationStreamEvent) => {
      raw.write(conversationEventBus.formatForSSE(event));
    };

    if (query.cursor) {
      for (const event of conversationEventBus.getHistoryAfter(threadId, query.cursor)) {
        sendEvent(event);
      }
    } else if (includeHistory) {
      for (const event of conversationEventBus.getHistory(threadId)) {
        sendEvent(event);
      }
    }

    const onEvent = (event: ConversationStreamEvent) => {
      sendEvent(event);
    };

    const keepAlive = setInterval(() => {
      raw.write(': keepalive\n\n');
    }, 15_000);

    const cleanup = () => {
      clearInterval(keepAlive);
      conversationEventBus.unsubscribe(threadId, onEvent);
      raw.end();
    };

    conversationEventBus.subscribe(threadId, onEvent);
    request.raw.on('close', cleanup);
  });
}
