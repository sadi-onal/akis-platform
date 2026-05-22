import { FastifyInstance } from 'fastify';
import { aiKeysRoutes } from './ai-keys.js';
import { profileRoutes } from './profile.js';
import { workspaceRoutes } from './workspace.js';
import { pipelineStatsRoutes } from './pipeline-stats.js';
import { integrityMetricsRoutes } from './integrity-metrics.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  await fastify.register(aiKeysRoutes, { prefix: '/settings' });
  await fastify.register(profileRoutes, { prefix: '/settings' });
  await fastify.register(workspaceRoutes, { prefix: '/settings' });
  await fastify.register(pipelineStatsRoutes, { prefix: '/settings' });
  await fastify.register(integrityMetricsRoutes, { prefix: '/settings' });
}
