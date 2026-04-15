import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../utils/auth.js';
import {
  deleteUserAiKey,
  getMultiProviderStatus,
  normalizeApiKey,
  setUserActiveProvider,
  upsertUserAiKey,
  type AIKeyProvider,
} from '../../services/ai/user-ai-keys.js';
import { getUserPlan, getUsageSummary } from '../../services/billing/BillingService.js';
import { sendError } from '../../utils/errorHandler.js';

const providerSchema = z.enum(['anthropic', 'openai', 'openrouter']);

// API key validation: Anthropic (sk-ant-...), OpenAI (sk-...), OpenRouter (sk-or-...)
const apiKeySchema = z
  .string()
  .min(20, 'API key must be at least 20 characters')
  .regex(/^\S+$/, 'API key must not include whitespace');

const upsertSchema = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
});

const deleteSchema = z.object({
  provider: providerSchema,
});

const setActiveProviderSchema = z.object({
  provider: providerSchema,
});

export async function aiKeysRoutes(fastify: FastifyInstance) {
  // GET /api/settings/ai-keys/status
  // Returns multi-provider status with active provider
  fastify.get(
    '/ai-keys/status',
    {
      schema: {
        tags: ['settings'],
        response: {
          200: {
            type: 'object',
            properties: {
              activeProvider: { type: ['string', 'null'], enum: ['anthropic', 'openai', 'openrouter', null] },
              providers: {
                type: 'object',
                properties: {
                  anthropic: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                  openai: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                  openrouter: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const [status, plan, usage] = await Promise.all([
          getMultiProviderStatus(user.id),
          getUserPlan(user.id),
          getUsageSummary(user.id),
        ]);

        // Determine effective key source: 'own' if user has a configured key for their active provider, else 'akis'
        const activeProviderKey = status.activeProvider;
        const hasOwnKey = activeProviderKey
          ? (status.providers as Record<string, { configured: boolean }>)[activeProviderKey]?.configured === true
          : false;
        const keySource: 'akis' | 'own' = hasOwnKey ? 'own' : 'akis';

        // Check if user's plan allows own keys (Free plan = no)
        const canUseOwnKey = plan.tier !== 'free';

        return reply.code(200).send({
          ...status,
          keySource,
          canUseOwnKey,
          plan: {
            tier: plan.tier,
            name: plan.name,
            jobsPerDay: plan.jobsPerDay,
            maxTokenBudget: plan.maxTokenBudget,
          },
          usage: {
            jobsUsedToday: usage.jobsUsedToday,
            tokensUsedThisMonth: usage.tokensUsedThisMonth,
            jobsLimit: usage.jobsLimit,
            tokensLimit: usage.tokensLimit,
          },
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
        }
        if (err instanceof Error && err.message.includes('AI_KEY_ENCRYPTION_KEY')) {
          fastify.log.error('Encryption configuration error');
          return sendError(reply, request, 'ENCRYPTION_NOT_CONFIGURED',
            'Server encryption is not properly configured. Contact administrator.');
        }
        throw err;
      }
    }
  );

  // PUT /api/settings/ai-keys
  // Save API key for a specific provider
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fastify as any).put(
    '/ai-keys',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['provider', 'apiKey'],
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'openrouter'] },
            apiKey: { type: 'string', minLength: 20 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              configured: { type: 'boolean' },
              last4: { type: ['string', 'null'] },
              updatedAt: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = upsertSchema.parse(request.body);
        const provider = body.provider as AIKeyProvider;
        const normalized = normalizeApiKey(body.apiKey);

        const status = await upsertUserAiKey(user.id, provider, normalized);
        return reply.code(200).send(status);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
        }
        if (err instanceof z.ZodError) {
          return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid API key payload', err.errors);
        }
        if (err instanceof Error && err.message.includes('AI_KEY_ENCRYPTION_KEY')) {
          fastify.log.error('Encryption configuration error');
          return sendError(reply, request, 'ENCRYPTION_NOT_CONFIGURED',
            'Server encryption is not properly configured. Contact administrator.');
        }
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
          return sendError(reply, request, 'DUPLICATE_KEY', 'API key already exists for this provider');
        }
        throw err;
      }
    }
  );

  // PUT /api/settings/ai-provider/active
  // Set the active AI provider for the user
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fastify as any).put(
    '/ai-provider/active',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'openrouter'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              activeProvider: { type: ['string', 'null'], enum: ['anthropic', 'openai', 'openrouter', null] },
              providers: {
                type: 'object',
                properties: {
                  anthropic: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                  openai: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                  openrouter: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      last4: { type: ['string', 'null'] },
                      updatedAt: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = setActiveProviderSchema.parse(request.body);
        
        await setUserActiveProvider(user.id, body.provider);
        const status = await getMultiProviderStatus(user.id);
        
        return reply.code(200).send(status);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
        }
        if (err instanceof z.ZodError) {
          return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid provider', err.errors);
        }
        if (err instanceof Error && err.message.includes('AI_KEY_ENCRYPTION_KEY')) {
          fastify.log.error('Encryption configuration error');
          return sendError(reply, request, 'ENCRYPTION_NOT_CONFIGURED',
            'Server encryption is not properly configured. Contact administrator.');
        }
        throw err;
      }
    }
  );

  // DELETE /api/settings/ai-keys
  // Delete API key for a specific provider
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fastify as any).delete(
    '/ai-keys',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['settings'],
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'openrouter'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = deleteSchema.parse(request.body);
        const provider = body.provider as AIKeyProvider;

        await deleteUserAiKey(user.id, provider);
        return reply.code(200).send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
        }
        if (err instanceof z.ZodError) {
          return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid request', err.errors);
        }
        if (err instanceof Error && err.message.includes('AI_KEY_ENCRYPTION_KEY')) {
          fastify.log.error('Encryption configuration error');
          return sendError(reply, request, 'ENCRYPTION_NOT_CONFIGURED',
            'Server encryption is not properly configured. Contact administrator.');
        }
        throw err;
      }
    }
  );
}
