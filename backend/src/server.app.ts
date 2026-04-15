// NOTE: Do NOT import 'dotenv/config' here.
// Env loading is handled by config/env.ts with correct precedence:
// 1) Shell exports  2) backend/.env.local  3) backend/.env
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { getEnv, getAIConfig } from './config/env.js';
import { isEncryptionConfigured } from './utils/crypto.js';
import { isEmailConfigured } from './services/email/index.js';
import { registerAgents } from './core/agents/registry.js';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { indexRoutes } from './api/index.js';
import { healthRoutes } from './api/health.js';
import { agentsRoutes, setOrchestrator } from './api/agents.js';
import { metricsRoutes, metrics } from './api/metrics.js';
import { authRoutes } from './api/auth.js';
import { agentConfigRoutes } from './api/agent-configs.js';
import { integrationsRoutes } from './api/integrations.js';
import { testHelpersRoutes } from './api/test-helpers.js';
import { settingsRoutes } from './api/settings/index.js';
import { usageRoutes } from './api/usage.js';
import { jobEventsRoutes } from './api/job-events.js';
import { webhookRoutes, setWebhookOrchestrator } from './api/webhooks.js';
import { triggersRoutes } from './api/triggers.js';
import { registerPlaybookRoutes } from './api/playbooks.js';
import { dashboardMetricsRoutes } from './api/dashboard-metrics.js';
import { aiModelsRoutes } from './api/ai-models.js';
import { feedbackRoutes } from './api/feedback.js';
import { conversationsRoutes } from './api/conversations.js';
import { studioRoutes } from './api/studio.js';
import { knowledgeRoutes } from './api/knowledge.js';
import { marketplaceRoutes } from './api/marketplace.js';
import { crewRoutes, initCrewRunManager } from './api/crew.js';
import { ragRoutes } from './api/rag.js';
import { adminRoutes } from './api/admin.js';
import { githubRoutes, getGitHubToken } from './api/github.js';
import { billingRoutes } from './api/billing.js';
import { pipelinePlugin } from './pipeline/api/pipeline.plugin.js';
import { pipelineStreamPlugin } from './pipeline/api/pipeline-stream.plugin.js';
import { devSessionPlugin } from './pipeline/api/dev-session.plugin.js';
import { createPipelineSystem, type GitHubServiceLike } from './pipeline/core/pipeline-factory.js';
import { createGitHubRESTAdapter, getGitHubOwnerViaREST } from './pipeline/adapters/GitHubRESTAdapter.js';
import { pushLog } from './lib/logBuffer.js';
import { logger } from './lib/logger.js';
import { initPiriRAGService } from './services/rag/PiriRAGService.js';
import { AgentOrchestrator } from './core/orchestrator/AgentOrchestrator.js';
import { createAIService, createToolCallingClient } from './services/ai/AIService.js';
import type { MCPTools } from './services/mcp/adapters/index.js';
import { GitHubMCPService } from './services/mcp/adapters/GitHubMCPService.js';
import { StaleJobWatchdog } from './core/watchdog/StaleJobWatchdog.js';
import {
  FreshnessScheduler,
  setFreshnessSchedulerInstance,
} from './services/knowledge/FreshnessScheduler.js';
import { formatErrorResponse, getStatusCodeForError, type ErrorCode } from './utils/errorHandler.js';
import { requireAuth } from './utils/auth.js';
import { ZodError } from 'zod';

const QUIET_ROUTES = new Set([
  '/api/agents/jobs/running',
  '/api/agents/configs',
  '/api/usage/current-month',
  '/health',
  '/ready',
]);

/**
 * Build Fastify app instance (for testing and production)
 * Phase 5.D: Initialize orchestrator with AIService and MCPTools DI
 * Separated from server.listen() to allow testing with inject()
 */
export async function buildApp() {
  // Validate environment variables at startup (fail-fast)
  const env = getEnv();

  // Register all agents with the factory
  registerAgents();

  // Phase 10: Create AIService with resolved configuration
  // Uses getAIConfig() which handles legacy OPENROUTER_*/OPENAI_* variable fallbacks
  const aiConfig = getAIConfig(env);
  const aiService = createAIService(aiConfig);

  // Log AI service configuration (without secrets)
  const configSummary = aiService.getConfigSummary();
  logger.info(`[buildApp] AI Provider: ${configSummary.provider}`);
  logger.info(`[buildApp] AI Models: default=${configSummary.models.default}, planner=${configSummary.models.planner}, validation=${configSummary.models.validation}`);
  logger.info(`[buildApp] AI Base URL: ${configSummary.baseUrl}`);
  logger.info(`[buildApp] AI API Key: ${configSummary.hasApiKey ? 'configured' : 'NOT CONFIGURED'}`);

  // Startup diagnostics for encryption, email, OAuth, and MCP (no secrets)
  logger.info(`[buildApp] Encryption: ${isEncryptionConfigured() ? 'configured' : 'NOT CONFIGURED — AI key save will return 503'}`);
  logger.info(`[buildApp] Email: provider=${env.EMAIL_PROVIDER}, configured=${isEmailConfigured(env.EMAIL_PROVIDER)}`);
  logger.info(`[buildApp] OAuth: google=${env.GOOGLE_OAUTH_CLIENT_ID ? 'configured' : 'NOT SET'}, github=${env.GITHUB_OAUTH_CLIENT_ID ? 'configured' : 'NOT SET'}`);
  if (env.GOOGLE_OAUTH_CLIENT_ID || env.GITHUB_OAUTH_CLIENT_ID) {
    logger.info(`[buildApp] OAuth callback base: ${env.BACKEND_URL}/auth/oauth/<provider>/callback`);
  }
  logger.info(`[buildApp] MCP: GITHUB_MCP_BASE_URL=${env.GITHUB_MCP_BASE_URL ? '(configured)' : 'NOT SET — agents requiring GitHub will fail'}`);
  if (env.EMAIL_PROVIDER === 'smtp') {
    logger.info(`[buildApp] SMTP: host=${process.env.SMTP_HOST || 'NOT SET'}, port=${process.env.SMTP_PORT || '587'}, from=${process.env.SMTP_FROM_EMAIL || 'NOT SET'}`);
  }

  // Phase 5.D: Create MCPTools (signature-only adapters for now)
  // In production, these would be initialized with real tokens/baseUrls
  const mcpTools: MCPTools = {
    // Adapters are signature-only, so we don't instantiate them yet
    // githubMCP: new GitHubMCPService({ baseUrl: env.GITHUB_MCP_BASE_URL || '', token: '...' }),
    // jiraMCP: new JiraMCPService({ baseUrl: env.ATLASSIAN_MCP_BASE_URL || '', token: '...' }),
    // confluenceMCP: new ConfluenceMCPService({ baseUrl: env.ATLASSIAN_MCP_BASE_URL || '', token: '...' }),
  };

  // Phase 5.D: Create orchestrator with DI
  const orchestrator = new AgentOrchestrator({}, aiService, mcpTools);
  setOrchestrator(orchestrator);
  setWebhookOrchestrator(orchestrator);

  // M2: Initialize Crew Run Manager (Agent Teams)
  initCrewRunManager(async (payload) => {
    const jobId = await orchestrator.submitJob(payload as never);
    return { id: jobId };
  });

  // Start stale job watchdog
  const watchdog = new StaleJobWatchdog();
  watchdog.start();

  // Start knowledge freshness scheduler (M2-FP-1)
  let freshnessScheduler: FreshnessScheduler | null = null;
  if (env.FRESHNESS_SCHEDULER_ENABLED) {
    const githubMcp =
      env.GITHUB_MCP_BASE_URL && env.GITHUB_TOKEN
        ? new GitHubMCPService({
            baseUrl: env.GITHUB_MCP_BASE_URL,
            token: env.GITHUB_TOKEN,
            correlationId: 'freshness-scheduler',
          })
        : null;

    freshnessScheduler = new FreshnessScheduler({
      githubMcp,
      intervalMs: env.FRESHNESS_SCHEDULER_INTERVAL_MINUTES * 60 * 1000,
      freshnessThresholdDays: env.FRESHNESS_THRESHOLD_DAYS,
      agingThresholdDays: env.FRESHNESS_AGING_THRESHOLD_DAYS,
    });
    setFreshnessSchedulerInstance(freshnessScheduler);
    freshnessScheduler.start();
    logger.info(
      `[buildApp] Freshness scheduler enabled (interval=${env.FRESHNESS_SCHEDULER_INTERVAL_MINUTES}m, threshold=${env.FRESHNESS_THRESHOLD_DAYS}d)`
    );
  } else {
    setFreshnessSchedulerInstance(null);
    logger.info('[buildApp] Freshness scheduler disabled');
  }

  // Phase 7.A: Enable structured logging with request-id
  const isTest = process.env.NODE_ENV === 'test';
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    logger: isTest
      ? false
      : {
          level: process.env.LOG_LEVEL || 'info',
          transport:
            process.env.NODE_ENV === 'development'
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                  },
                }
              : undefined,
        },
    disableRequestLogging: true,
    requestIdHeader: 'request-id',
    requestIdLogLabel: 'requestId',
    genReqId: (req: FastifyRequest) => {
      // Accept inbound request-id header if present, else generate UUID
      return (req.headers['request-id'] as string) || randomUUID();
    },
  });

  // Phase 7.A: Add request logging hook
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Fastify automatically sets request.id from genReqId
    // We can attach it to the reply for later use
    reply.requestId = request.id;
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const duration = reply.elapsedTime! / 1000;
    const route: string = request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0];
    metrics.httpDuration.observe(
      {
        method: request.method,
        route,
        status_code: reply.statusCode.toString(),
      },
      duration
    );

    if (app.log && !QUIET_ROUTES.has(route)) {
      const entry = {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        requestId: request.id,
        duration,
        msg: 'request completed',
        level: 30,
      };
      pushLog(entry);
      app.log.info(entry, 'request completed');
    }
  });

  // Phase 7.C: Register Swagger/OpenAPI
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AKIS Platform API',
        description: 'AI Agent Workflow Engine API',
        version: '0.2.0',
      },
      servers: [
        {
          url: env.BACKEND_URL || 'http://localhost:3000',
          description: 'Development server',
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header: string) => header,
  });

  // Register multipart plugin for file uploads (before routes, after swagger)
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 5, fieldSize: 50_000 },
    attachFieldsToBody: false, // We'll use request.parts() manually
  });

  // Register routes (order matters: root first, then specific routes)
  await app.register(indexRoutes);
  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(agentsRoutes);
  await app.register(agentConfigRoutes);
  await app.register(integrationsRoutes);
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(usageRoutes);
  await app.register(jobEventsRoutes);
  await app.register(webhookRoutes);
  await app.register(triggersRoutes);
  await app.register(registerPlaybookRoutes);
  await app.register(dashboardMetricsRoutes);
  await app.register(aiModelsRoutes);
  await app.register(feedbackRoutes);
  await app.register(conversationsRoutes);
  await app.register(studioRoutes, { prefix: '/api/studio' });
  await app.register(knowledgeRoutes);
  await app.register(marketplaceRoutes);
  await app.register(crewRoutes);
  await app.register(ragRoutes);
  await app.register(adminRoutes);
  await app.register(billingRoutes);
  await app.register(githubRoutes, { prefix: '/api/github' });

  // Agent activities stub (returns empty until full wiring)
  app.get('/api/agent-activities', async () => ({ activities: [] }));
  app.get('/api/agent-activities/:id', async () => ({ activities: [] }));

  // Pipeline routes (Scribe → Proto → Trace pipeline)
  // Priority: 1) MCP Gateway (if available), 2) REST API, 3) Stub
  let pipelineGitHubService: GitHubServiceLike;
  let _pipelineGetGitHubOwner: (userId: string) => Promise<string>;

  const hasRealGitHubToken = env.GITHUB_TOKEN && !env.GITHUB_TOKEN.startsWith('<') && env.GITHUB_TOKEN.length > 10;
  const hasMCPGateway = !!(env.GITHUB_MCP_BASE_URL && hasRealGitHubToken);

  if (hasMCPGateway) {
    // MCP Gateway — standardized tool protocol
    const mcpService = new GitHubMCPService({
      baseUrl: env.GITHUB_MCP_BASE_URL!,
      token: env.GITHUB_TOKEN!,
      correlationId: 'pipeline',
    });
    const { createGitHubMCPAdapter } = await import('./pipeline/adapters/GitHubMCPAdapter.js');
    pipelineGitHubService = createGitHubMCPAdapter(mcpService);
    const ghToken = env.GITHUB_TOKEN!;
    _pipelineGetGitHubOwner = async () => {
      try {
        return await getGitHubOwnerViaREST(ghToken);
      } catch {
        return 'unknown';
      }
    };
    logger.info(`[buildApp] Pipeline GitHub: MCP Gateway (${env.GITHUB_MCP_BASE_URL})`);
  } else if (hasRealGitHubToken) {
    // Fallback: Direct REST API — works without MCP Gateway
    pipelineGitHubService = createGitHubRESTAdapter({ token: env.GITHUB_TOKEN! });
    const ghToken = env.GITHUB_TOKEN!;
    _pipelineGetGitHubOwner = async () => {
      try {
        return await getGitHubOwnerViaREST(ghToken);
      } catch {
        return 'unknown';
      }
    };
    logger.info('[buildApp] Pipeline GitHub: REST API (set GITHUB_MCP_BASE_URL for MCP)');
  } else {
    // Option 3: No token — fail-hard mode (no silent stubs)
    const noTokenError = () => { throw new Error('GitHub token yapilandirilmamis. Pipeline calistirmak icin GITHUB_TOKEN veya GitHub OAuth baglantisi gereklidir.'); };
    pipelineGitHubService = {
      async createRepository() { noTokenError(); return { url: '' }; },
      async createBranch() { noTokenError(); },
      async commitFile() { noTokenError(); },
      async createPR() { noTokenError(); return { url: '' }; },
      async listFiles() { noTokenError(); return []; },
      async getFileContent() { noTokenError(); return ''; },
    };
    _pipelineGetGitHubOwner = async () => { noTokenError(); return ''; };
    logger.warn('[buildApp] Pipeline GitHub: NOT CONFIGURED (GITHUB_TOKEN or OAuth required)');
  }

  // PostgreSQL pipeline store (replaces InMemoryPipelineStore)
  const { DrizzlePipelineStore } = await import('./pipeline/db/DrizzlePipelineStore.js');
  const { db: drizzleDb } = await import('./db/client.js');
  const pipelineStore = new DrizzlePipelineStore(drizzleDb);

  const { orchestrator: pipelineOrchestrator, reconciler: pipelineReconciler } = createPipelineSystem({
    aiService,
    createGitHubService: (token: string) => createGitHubRESTAdapter({ token }),
    fallbackGitHubService: pipelineGitHubService,
    getGitHubOwner: async (userId: string) => {
      // Per-user token first, then platform fallback
      const userToken = await getGitHubToken(userId);
      const token = userToken ?? env.GITHUB_TOKEN;
      if (!token || token.startsWith('<')) return 'unknown';
      try { return await getGitHubOwnerViaREST(token); } catch { return 'unknown'; }
    },
    getGitHubToken: async (userId: string) => {
      const userToken = await getGitHubToken(userId);
      if (userToken) return userToken;
      // Fallback to platform token
      if (env.GITHUB_TOKEN && !env.GITHUB_TOKEN.startsWith('<') && env.GITHUB_TOKEN.length > 10) {
        return env.GITHUB_TOKEN;
      }
      return null;
    },
    store: pipelineStore,
    agenticDeps: { callWithTools: createToolCallingClient() },
  });
  // Start reconciler to recover stuck pipelines (clean shutdown via onClose)
  pipelineReconciler.start();
  app.addHook('onClose', () => pipelineReconciler.stop());
  // Resolve dev user for DEV_MODE auth bypass
  let devUserId: string | undefined;
  if (process.env.DEV_MODE === 'true') {
    try {
      const { db } = await import('./db/client.js');
      const { users: usersTable } = await import('./db/schema.js');
      const { eq } = await import('drizzle-orm');
      const devUser = await db.query.users.findFirst({
        where: eq(usersTable.status, 'active'),
      });
      devUserId = devUser?.id;
      if (devUserId) {
        logger.info(`[buildApp] Pipeline DEV_MODE: auth bypass with user ${devUserId}`);
      }
    } catch {
      logger.info('[buildApp] Pipeline DEV_MODE: could not resolve dev user, auth required');
    }
  }
  await app.register(
    async (instance) => pipelinePlugin(instance, { orchestrator: pipelineOrchestrator, requireAuth, devUserId }),
    { prefix: '/api/pipelines' },
  );
  await app.register(
    async (instance) => pipelineStreamPlugin(instance, { requireAuth, devUserId, orchestrator: pipelineOrchestrator }),
    { prefix: '/api/pipelines' },
  );
  await app.register(
    async (instance) => devSessionPlugin(instance, {
      aiService,
      githubToken: hasRealGitHubToken ? env.GITHUB_TOKEN! : null,
      orchestrator: pipelineOrchestrator,
      requireAuth,
      devUserId,
    }),
    { prefix: '/api/pipelines' },
  );

  // Initialize Piri RAG service if configured
  if (env.PIRI_BASE_URL) {
    initPiriRAGService(env.PIRI_BASE_URL);
    app.log.info(`Piri RAG service configured: ${env.PIRI_BASE_URL}`);
  }

  if (env.NODE_ENV !== 'production' && process.env.SCRIBE_DEV_GITHUB_BOOTSTRAP === 'true') {
    await app.register(testHelpersRoutes, { prefix: '/test' });
  }

  // Phase 7.C: Expose OpenAPI JSON at /openapi.json (after routes are registered)
  app.get('/openapi.json', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type('application/json');
    return app.swagger();
  });

  // ── AGT-6: Global error handler ──
  // Catches unhandled errors and formats them using the standard error envelope.
  // Route handlers that use sendError() directly do NOT trigger this handler.
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    // ZodError → VALIDATION_ERROR (400)
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.errors,
        },
        requestId: request.id,
      });
    }

    // Fastify validation errors (from JSON schema)
    if ('validation' in error && Array.isArray((error as { validation?: unknown[] }).validation)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message || 'Request validation failed',
          details: (error as { validation: unknown[] }).validation,
        },
        requestId: request.id,
      });
    }

    // Known application errors → standard envelope
    const envelope = formatErrorResponse(request, error);
    const statusCode = getStatusCodeForError(envelope.error.code as ErrorCode);

    if (statusCode >= 500 && app.log) {
      const route = request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0];
      const userId = request.user?.id ?? null;
      app.log.error({
        err: error,
        requestId: request.id,
        route,
        userId,
        msg: 'unhandled_server_error',
      });
    }

    return reply.code(statusCode).send(envelope);
  });

  // 404 handler — standard error envelope (must be registered after all routes)
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
      requestId: request.id,
    });
  });

  app.addHook('onClose', async () => {
    watchdog.stop();
    freshnessScheduler?.stop();
    setFreshnessSchedulerInstance(null);
  });

  return app;
}
