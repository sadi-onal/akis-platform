/**
 * Shared logger for use outside Fastify request context (e.g. orchestrator).
 * Same config as server: pino-pretty in dev, JSON in prod.
 * Orchestrator/agents push to log buffer explicitly for /api/admin/logs.
 */
import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';
// Prod ships JSON; everything else (dev, undefined, etc.) gets pretty.
// Module load happens BEFORE dotenv runs, so NODE_ENV is often undefined here
// even in dev — checking !== 'production' is the only reliable signal.
const isProd = process.env.NODE_ENV === 'production';

export const logger = isTest
  ? pino({ level: 'silent' })
  : pino({
      level: process.env.LOG_LEVEL || 'info',
      ...(!isProd && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:HH:MM:ss',
          },
        },
      }),
    });
