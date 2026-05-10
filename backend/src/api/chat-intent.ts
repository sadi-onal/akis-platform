/**
 * /api/chat/intent — intent classifier HTTP surface (FR-11).
 *
 * POST  /api/chat/intent              — classify a single user message
 * PATCH /api/chat/intent/:id          — record a disambiguation override
 *
 * Anchors:
 *   - 03-architecture § 3.1 (IntentClassifier) + § 4.3 (table) + § 5.2 (sequence)
 *   - 06-roadmap Wave 4 PR 4.1
 *   - 02-ux storyboard 1.5 + § 5.9 (disambiguation modal)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../utils/auth.js';
import {
  IntentClassifier,
  type IntentClassifierDeps,
  type IntentLabel,
} from '../pipeline/core/intent/IntentClassifier.js';
import type { AIServiceLike } from '../pipeline/core/pipeline-factory.js';

export interface ChatIntentPluginOptions {
  aiService: AIServiceLike;
  /** Provider id (anthropic | openai | mock) — controls AI vs regex path. */
  provider: string;
}

const VALID_INTENTS: ReadonlySet<string> = new Set(['BUILD', 'ASK', 'FEEDBACK', 'CHAT']);

/** Body validation (lightweight; we don't load Ajv just for one field). */
function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function chatIntentRoutes(
  fastify: FastifyInstance,
  opts: ChatIntentPluginOptions,
) {
  const deps: IntentClassifierDeps = {
    aiService: opts.aiService,
    db,
    logger,
    provider: opts.provider,
  };
  const classifier = new IntentClassifier(deps);

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/chat/intent
  // ────────────────────────────────────────────────────────────────────────
  fastify.post(
    '/api/chat/intent',
    {
      schema: {
        description: 'Classify a chat message into BUILD | ASK | FEEDBACK | CHAT (FR-11.1).',
        tags: ['chat-intent'],
        body: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 8000 },
            pipelineId: { type: 'string', format: 'uuid' },
            recentMessages: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 20,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              intent: { type: 'string' },
              confidence: { type: 'number' },
              reasoning: { type: 'string' },
              alternates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    intent: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                },
              },
              classificationId: { type: 'string' },
              threshold: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = (request.body ?? {}) as Record<string, unknown>;

        if (!isString(body.message) || body.message.trim().length === 0) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'message is required' },
          });
        }

        const pipelineId = isString(body.pipelineId) ? body.pipelineId : undefined;
        const recentMessages = isStringArray(body.recentMessages)
          ? body.recentMessages
          : undefined;

        const result = await classifier.classify(user.id, body.message, {
          pipelineId,
          recentMessages,
        });

        return reply.send({
          ...result,
          threshold: classifier.disambiguationThreshold,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // PATCH /api/chat/intent/:classificationId
  // (`fastify.route` because the .patch() shorthand isn't always typed in
  //  this Fastify v4 + plugin set.)
  // ────────────────────────────────────────────────────────────────────────
  fastify.route({
    method: 'PATCH',
    url: '/api/chat/intent/:classificationId',
    schema: {
      description:
        'Record a user disambiguation override on a low-confidence classification (FR-11.3).',
      tags: ['chat-intent'],
      params: {
        type: 'object',
        required: ['classificationId'],
        properties: {
          classificationId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['overrideIntent'],
        properties: {
          overrideIntent: {
            type: 'string',
            enum: ['BUILD', 'ASK', 'FEEDBACK', 'CHAT'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const { classificationId } = request.params as { classificationId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const overrideIntent = isString(body.overrideIntent) ? body.overrideIntent.toUpperCase() : '';
        if (!VALID_INTENTS.has(overrideIntent)) {
          return reply.code(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'overrideIntent must be one of BUILD|ASK|FEEDBACK|CHAT' },
          });
        }
        try {
          // IDOR fix: scope override to the authenticated user — `userId` is
          // included in the WHERE so a user cannot mutate someone else's row.
          await classifier.overrideClassification(
            classificationId,
            overrideIntent as IntentLabel,
            user.id,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'INVALID_CLASSIFICATION_ID') {
            return reply.code(400).send({
              error: { code: 'VALIDATION_ERROR', message: 'classificationId is malformed' },
            });
          }
          if (msg === 'NOT_FOUND') {
            return reply.code(404).send({
              error: { code: 'NOT_FOUND', message: 'Classification not found' },
            });
          }
          throw err;
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    },
  });
}
