/**
 * Shared logger for use outside Fastify request context (e.g. orchestrator).
 * Same config as server: pino-pretty in dev, JSON in prod.
 * Orchestrator/agents push to log buffer explicitly for /api/admin/logs.
 */
import pino from 'pino';

const env = process.env.NODE_ENV ?? 'production';

const isTest = env === 'test';
const isDev = env === 'development';

export const logger = isTest
  ? pino({ level: 'silent' })
  : isDev
  ? pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    })
  : pino({
      level: process.env.LOG_LEVEL || 'info',
    });