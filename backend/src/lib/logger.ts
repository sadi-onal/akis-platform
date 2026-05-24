/**
 * Shared logger for use outside Fastify request context (e.g. orchestrator).
 * Same config as server: pino-pretty in dev, JSON in prod.
 * Orchestrator/agents push to log buffer explicitly for /api/admin/logs.
 *
 * TIMING NOTE: This module is imported at the top of many files, so it runs
 * BEFORE dotenv has a chance to load .env. As a result, process.env.LOG_LEVEL
 * reflects only shell-exported vars at module load time — values in .env are
 * NOT available here. For dev, either export LOG_LEVEL in your shell or use
 * setLogLevel() after env loads. The Fastify instance logger (in server.app.ts)
 * reads LOG_LEVEL at buildApp() time when dotenv HAS run, so it works correctly.
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

/**
 * Update the logger level after environment has loaded (e.g., after dotenv runs).
 * Call from server startup if LOG_LEVEL from .env should override the default.
 */
export function setLogLevel(level: string): void {
  logger.level = level;
}
