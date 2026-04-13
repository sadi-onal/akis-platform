import cors from '@fastify/cors';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { logger } from '../../lib/logger.js';

export interface CorsPluginOptions {
  origins: string[];
}

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];

export const corsPlugin = fp<CorsPluginOptions>(
  async (fastify: FastifyInstance, options: CorsPluginOptions) => {
    const normalizedOrigins = new Set<string>(
      options.origins
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) => origin.replace(/\/$/, ''))
    );

    const shouldAllowDevOrigins = process.env.NODE_ENV !== 'production';
    if (shouldAllowDevOrigins) {
      for (const origin of DEV_ORIGINS) {
        normalizedOrigins.add(origin);
      }
    }

    const allowAll = normalizedOrigins.has('*');

    // Security: credentials + wildcard origin is dangerous — disable credentials if wildcard
    if (allowAll && process.env.NODE_ENV === 'production') {
      logger.warn('[CORS] Wildcard origin (*) with credentials is insecure in production. Disabling credentials.');
    }

    await fastify.register(cors, {
      credentials: !allowAll,
      exposedHeaders: ['set-cookie'],
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow: boolean) => void
      ) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        const sanitizedOrigin = origin.replace(/\/$/, '');

        if (allowAll || normalizedOrigins.has(sanitizedOrigin)) {
          callback(null, true);
          return;
        }

        callback(null, false);
      },
    });
  }
);

export type CorsPlugin = typeof corsPlugin;

