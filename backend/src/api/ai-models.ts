import { FastifyInstance } from 'fastify';
import { getScribeModelAllowlistByProvider, getRecommendedModel } from '../services/ai/modelAllowlist.js';
import { requireAuth } from '../utils/auth.js';
import { getUserActiveProvider, type AIKeyProvider } from '../services/ai/user-ai-keys.js';

export async function aiModelsRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/ai/supported-models?provider=anthropic|openai
   * Returns provider-specific list of supported AI models for agent jobs.
   * If provider omitted, uses user's active provider from DB; default 'anthropic'.
   *
   * P1a: 'openai' returns DEFAULT_OPENAI_MODELS now that the runtime client
   * is wired up in AIService.
   */
  fastify.get(
    '/api/ai/supported-models',
    {
      schema: {
        description: 'Get list of supported AI models (provider-aware)',
        tags: ['ai'],
        querystring: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              models: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    provider: { type: 'string' },
                    recommended: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      let provider: AIKeyProvider = 'anthropic';

      // If explicit provider param, use it
      const query = request.query as Record<string, string> | undefined;
      const providerParam = query?.provider;
      if (providerParam === 'anthropic' || providerParam === 'openai') {
        provider = providerParam;
      } else {
        // Try to get user's active provider from DB
        try {
          const user = await requireAuth(request);
          const userProvider = await getUserActiveProvider(user.id);
          if (userProvider) {
            provider = userProvider;
          }
        } catch {
          // Not authenticated — fall back to anthropic
        }
      }

      const allowlist = getScribeModelAllowlistByProvider(provider);
      const recommendedModel = getRecommendedModel(provider);

      const models = allowlist.map((modelId) => ({
        id: modelId,
        name: modelId,
        provider,
        recommended: modelId === recommendedModel,
      }));

      return { provider, models };
    }
  );
}
