import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { buildApp } from './server.app.js';
import { getEnv } from './config/env.js';
import { corsPlugin } from './plugins/security/cors.js';
import { helmetPlugin } from './plugins/security/helmet.js';
import { runSchemaGuard } from './utils/schemaGuard.js';

const env = getEnv();

// PR-2: Run schema guard before starting server (dev-only exit on failure)
await runSchemaGuard();

const app = await buildApp();

// Safe JSON parser that handles empty bodies
// Type assertion needed due to loose typings in custom fastify.d.ts
type ContentParserFn = (
  req: unknown,
  body: string,
  done: (err: Error | null, result?: unknown) => void
) => void;

const emptyBodyParser: ContentParserFn = (_req, body, done) => {
  // Handle empty body - return empty object instead of throwing
  if (!body || body.trim() === '') {
    done(null, {});
    return;
  }
  try {
    const json = JSON.parse(body);
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
};

app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  emptyBodyParser as (...args: unknown[]) => unknown
);

// Security headers
await app.register(helmetPlugin, {
  enableCSP: env.NODE_ENV === 'production',
});

// Response compression (gzip/brotli — reduces bandwidth on OCI Free Tier)
await app.register(compress, { global: true });

// Soft rate limit
await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
  hook: 'onSend',
});

// CORS
await app.register(corsPlugin, {
  origins: env.CORS_ORIGINS,
});

// NOTE: @fastify/cookie (cookiesPlugin) is registered inside buildApp() now —
// both prod server.ts and test harness (app.inject) go through the same path.

const port = env.AKIS_PORT;
const host = env.AKIS_HOST;

app.listen({ port, host }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening on http://${host}:${port}`);
});