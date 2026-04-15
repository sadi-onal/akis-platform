import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentTriggers } from '../db/triggers-schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../utils/auth.js';
import { formatErrorResponse, getStatusCodeForError } from '../utils/errorHandler.js';

const createTriggerSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  branch: z.string().min(1).default('main'),
  eventType: z.enum(['pr_merged', 'pr_opened', 'push']),
  agentType: z.enum(['scribe', 'trace', 'proto']),
  enabled: z.boolean().default(true),
});

const updateTriggerSchema = z.object({
  enabled: z.boolean().optional(),
  branch: z.string().min(1).optional(),
  eventType: z.enum(['pr_merged', 'pr_opened', 'push']).optional(),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
});

const triggerIdSchema = z.object({
  id: z.string().uuid(),
});

export async function triggersRoutes(fastify: FastifyInstance) {
  // GET /api/triggers - List triggers
  fastify.get(
    '/api/triggers',
    {
      schema: {
        description: 'List triggers for authenticated user',
        tags: ['triggers'],
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const triggers = await db
          .select()
          .from(agentTriggers)
          .where(eq(agentTriggers.userId, user.id));

        return { triggers };
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // POST /api/triggers - Create trigger
  fastify.post(
    '/api/triggers',
    {
      schema: {
        description: 'Create a new trigger',
        tags: ['triggers'],
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const body = createTriggerSchema.parse(request.body);

        const [trigger] = await db
          .insert(agentTriggers)
          .values({
            userId: user.id,
            repoOwner: body.repoOwner,
            repoName: body.repoName,
            branch: body.branch,
            eventType: body.eventType,
            agentType: body.agentType,
            enabled: body.enabled,
          })
          .returning();

        return reply.code(201).send({ trigger });
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // PUT /api/triggers/:id - Update trigger
  fastify.put(
    '/api/triggers/:id',
    {
      schema: {
        description: 'Update a trigger',
        tags: ['triggers'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const params = triggerIdSchema.parse(request.params);
        const body = updateTriggerSchema.parse(request.body);

        const [existing] = await db
          .select()
          .from(agentTriggers)
          .where(and(eq(agentTriggers.id, params.id), eq(agentTriggers.userId, user.id)))
          .limit(1);

        if (!existing) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.enabled !== undefined) updates.enabled = body.enabled;
        if (body.branch !== undefined) updates.branch = body.branch;
        if (body.eventType !== undefined) updates.eventType = body.eventType;
        if (body.agentType !== undefined) updates.agentType = body.agentType;

        const [updated] = await db
          .update(agentTriggers)
          .set(updates)
          .where(eq(agentTriggers.id, params.id))
          .returning();

        return { trigger: updated };
      } catch (error: unknown) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // DELETE /api/triggers/:id - Delete trigger
  fastify.delete(
    '/api/triggers/:id',
    {
      schema: {
        description: 'Delete a trigger',
        tags: ['triggers'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const params = triggerIdSchema.parse(request.params);

        const [existing] = await db
          .select()
          .from(agentTriggers)
          .where(and(eq(agentTriggers.id, params.id), eq(agentTriggers.userId, user.id)))
          .limit(1);

        if (!existing) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Trigger not found' } });
        }

        await db.delete(agentTriggers).where(eq(agentTriggers.id, params.id));

        return reply.code(200).send({ success: true, message: 'Trigger deleted' });
      } catch (error: unknown) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );
}
