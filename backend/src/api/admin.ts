/**
 * Admin API - Log viewer and dev tools
 * GET /api/admin/logs returns recent in-memory log buffer.
 */
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../utils/auth.js';
import { getLogs } from '../lib/logBuffer.js';

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/api/admin/logs',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const query = request.query as { level?: string; limit?: string; since?: string };
      const level = query.level ?? 'info';
      const limit = Math.min(parseInt(query.limit ?? '100', 10) || 100, 500);
      const since = query.since ? parseInt(query.since, 10) : undefined;
      const entries = getLogs({ level, limit, since: since && !Number.isNaN(since) ? since : undefined });
      return reply.code(200).send({ logs: entries });
    }
  );
}
