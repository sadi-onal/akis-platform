import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgentOrchestrator } from '../core/orchestrator/AgentOrchestrator.js';
import { db } from '../db/client.js';
import { jobs, jobPlans, jobAudits, jobTraces, jobArtifacts, agentConfigs, jobComments, jobAiCalls } from '../db/schema.js';
import { eq, desc, and, sql, asc, inArray } from 'drizzle-orm';
import { JobNotFoundError, MissingAIKeyError, ModelNotAllowedError } from '../core/errors.js';
import { metrics } from './metrics.js';
import { formatErrorResponse, getStatusCodeForError } from '../utils/errorHandler.js';
import { pushLog } from '../lib/logBuffer.js';
import { requireAuth } from '../utils/auth.js';
import { getUserAiKeyStatus } from '../services/ai/user-ai-keys.js';
import { getScribeModelAllowlist, RECOMMENDED_MODELS } from '../services/ai/modelAllowlist.js';
import { getEnv, getAIConfig } from '../config/env.js';
import { generateScribeBranchName } from '../utils/branchNaming.js';
import { generateQualitySuggestions, type QualityResult, type QualityInput } from '../services/quality/index.js';
import { logger } from '../lib/logger.js';

const MAX_ACTIVE_RUNS_PER_USER = 3;

// Request validation schemas
// Legacy payload schema (backward compatible)
const scribePayloadSchema = z.object({
  owner: z.string().min(1, 'owner field is required'),
  repo: z.string().min(1, 'repo field is required'),
  baseBranch: z.string().min(1, 'baseBranch field is required'),
  featureBranch: z.string().optional(),
  targetPath: z.string().optional(),
  taskDescription: z.string().optional(),
  // Maintain backward compatibility for legacy tests if needed, or remove 'doc'
  doc: z.string().optional(),
  // Doc Pack Generator fields
  docPack: z.enum(['readme', 'standard', 'full']).optional(),
  docDepth: z.enum(['lite', 'standard', 'deep']).optional(),
  outputTargets: z.array(z.string()).optional(),
  analyzeLastNCommits: z.number().int().min(1).max(100).optional(),
  maxOutputTokens: z.number().int().min(1000).max(64000).optional(),
  passes: z.number().int().min(1).max(2).optional(),
  skill: z.enum(['DocPackFromRepo', 'ReleaseNotesFromPRs', 'ChecklistFromRunbook']).optional(),
  skillInput: z.unknown().optional(),
  // Piri context fields
  contextQuery: z.string().max(2000).optional(),
  additionalContext: z.string().max(10000).optional(),
});

// Config-aware payload schema (S0.4.6)
const scribeConfigAwarePayloadSchema = z.object({
  mode: z.enum(['from_config', 'test', 'run']).optional(),
  config_id: z.string().uuid().optional(),
  dryRun: z.boolean().optional(),
}).passthrough(); // Allow additional fields for backward compat

const tracePayloadSchema = z.object({
  spec: z.string().min(1, 'spec field is required and must be a non-empty string'),
  owner: z.string().optional(),
  repo: z.string().optional(),
  baseBranch: z.string().optional(),
  branchStrategy: z.enum(['auto', 'manual']).optional(),
  dryRun: z.boolean().optional(),
  automationMode: z.enum(['plan_only', 'generate_and_run']).optional(),
  targetBaseUrl: z.string().url().optional(),
  featureLimit: z.number().int().min(1).max(100).optional(),
  tracePreferences: z.object({
    testDepth: z.enum(['smoke', 'standard', 'deep']),
    authScope: z.enum(['public', 'authenticated', 'mixed']),
    browserTarget: z.enum(['chromium', 'cross_browser', 'mobile']),
    strictness: z.enum(['fast', 'balanced', 'strict']),
  }).optional(),
  // Piri context fields
  contextQuery: z.string().max(2000).optional(),
  additionalContext: z.string().max(10000).optional(),
}).passthrough().superRefine((data, ctx) => {
  if (data.automationMode === 'generate_and_run' && !data.targetBaseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetBaseUrl is required when automationMode is generate_and_run',
      path: ['targetBaseUrl'],
    });
  }
});

const protoPayloadSchema = z.object({
  requirements: z.string().min(1, 'requirements field is required').optional(),
  goal: z.string().min(1, 'goal field is required').optional(),
  stack: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  baseBranch: z.string().optional(),
  branchStrategy: z.enum(['auto', 'manual']).optional(),
  dryRun: z.boolean().optional(),
  // Piri context fields
  contextQuery: z.string().max(2000).optional(),
  additionalContext: z.string().max(10000).optional(),
}).passthrough().superRefine((data, ctx) => {
  if (!data.requirements && !data.goal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either "requirements" or "goal" field must be provided',
      path: ['requirements'],
    });
  }
});

const runtimeProfileSchema = z.enum(['deterministic', 'balanced', 'creative', 'custom']);
const commandLevelSchema = z.number().int().min(1).max(5);
const runtimeOverrideSchema = z
  .object({
    runtimeProfile: runtimeProfileSchema.optional(),
    temperatureValue: z.number().min(0).max(1).optional().nullable(),
    commandLevel: commandLevelSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.runtimeProfile === 'custom' &&
      (data.temperatureValue === null || data.temperatureValue === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'temperatureValue is required when runtimeProfile is custom',
        path: ['temperatureValue'],
      });
    }
  });

type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
type CommandLevel = 1 | 2 | 3 | 4 | 5;

interface RuntimeControl {
  runtimeProfile: RuntimeProfile;
  temperatureValue: number | null;
  commandLevel: CommandLevel;
  allowCommandExecution: boolean;
  settingsVersion: number;
}

const DEFAULT_RUNTIME: RuntimeControl = {
  runtimeProfile: 'deterministic',
  temperatureValue: null,
  commandLevel: 2,
  allowCommandExecution: false,
  settingsVersion: 1,
};

function toNumericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ensureRuntimeControl(value: Partial<RuntimeControl> | null | undefined): RuntimeControl {
  const runtimeProfile = value?.runtimeProfile ?? DEFAULT_RUNTIME.runtimeProfile;
  const commandLevel = (value?.commandLevel ?? DEFAULT_RUNTIME.commandLevel) as CommandLevel;
  const temperatureValue =
    runtimeProfile === 'custom' ? value?.temperatureValue ?? DEFAULT_RUNTIME.temperatureValue : null;

  return {
    runtimeProfile,
    temperatureValue,
    commandLevel,
    allowCommandExecution: commandLevel >= 3,
    settingsVersion: value?.settingsVersion ?? DEFAULT_RUNTIME.settingsVersion,
  };
}

function applyRuntimeOverride(
  base: RuntimeControl,
  runtimeOverride?: z.infer<typeof runtimeOverrideSchema>
): RuntimeControl {
  if (!runtimeOverride) return base;
  const runtimeProfile = runtimeOverride.runtimeProfile ?? base.runtimeProfile;
  const commandLevel = (runtimeOverride.commandLevel ?? base.commandLevel) as CommandLevel;
  const temperatureValue =
    runtimeProfile === 'custom'
      ? runtimeOverride.temperatureValue ?? base.temperatureValue ?? null
      : null;

  return {
    runtimeProfile,
    temperatureValue,
    commandLevel,
    allowCommandExecution: commandLevel >= 3,
    settingsVersion: base.settingsVersion,
  };
}

// NOTE: coderPayloadSchema and developerPayloadSchema shelved for S0.5.
// See: _shelved/README.md for reactivation.

const submitJobSchema = z.object({
  type: z.enum(['scribe', 'trace', 'proto']),
  payload: z.unknown().optional(),
  runtimeOverride: runtimeOverrideSchema.optional(),
  /** If true, the job will use a stronger model for final validation */
  requiresStrictValidation: z.boolean().optional().default(false),
  /** If true, execution pauses after planning until explicit approval */
  requiresApproval: z.boolean().optional().default(false),
}).superRefine((data, ctx) => {
  // S0.4.6: Skip validation if config-aware payload (validation happens in route handler after config load)
  if (data.payload && typeof data.payload === 'object') {
    const payload = data.payload as Record<string, unknown>;
    
    // Check if this is a config-aware payload
    const isConfigAware = 
      payload.mode === 'from_config' || 
      payload.mode === 'test' || 
      payload.mode === 'run' || 
      typeof payload.config_id === 'string';
    
    if (data.type === 'scribe') {
      if (isConfigAware) {
        // Config-aware: validate schema but don't require owner/repo/baseBranch
        const result = scribeConfigAwarePayloadSchema.safeParse(data.payload);
        if (!result.success) {
          result.error.errors.forEach((err) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Scribe config-aware payload validation: ${err.message}`,
              path: ['payload', ...err.path],
            });
          });
        }
      } else {
        // Legacy: validate full payload
        const result = scribePayloadSchema.safeParse(data.payload);
        if (!result.success) {
          result.error.errors.forEach((err) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Scribe payload validation: ${err.message}`,
              path: ['payload', ...err.path],
            });
          });
        }
      }
    } else if (data.type === 'trace') {
      const result = tracePayloadSchema.safeParse(data.payload);
      if (!result.success) {
        result.error.errors.forEach((err) => {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Trace payload validation: ${err.message}`,
            path: ['payload', ...err.path],
          });
        });
      }
    } else if (data.type === 'proto') {
      const result = protoPayloadSchema.safeParse(data.payload);
      if (!result.success) {
        result.error.errors.forEach((err) => {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Proto payload validation: ${err.message}`,
            path: ['payload', ...err.path],
          });
        });
      }
    }
  } else if (data.type === 'scribe' || data.type === 'trace') {
    // Scribe and Trace require payload
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${data.type} agent requires a payload object`,
      path: ['payload'],
    });
  }
});

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const includeQuerySchema = z.object({
  include: z.string().optional(), // Comma-separated: 'plan,audit'
});

function extractJobUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawUserId = (payload as Record<string, unknown>).userId;
  if (typeof rawUserId !== 'string') return null;
  const normalizedUserId = rawUserId.trim();
  return normalizedUserId.length > 0 ? normalizedUserId : null;
}

function isJobOwnedByUser(payload: unknown, userId: string): boolean {
  const jobUserId = extractJobUserId(payload);
  return jobUserId === userId;
}

function sendJobNotFound(reply: FastifyReply, jobId: string, requestId?: string) {
  return reply.code(404).send({
    error: { code: 'NOT_FOUND', message: `Job ${jobId} not found` },
    ...(requestId ? { requestId } : {}),
  });
}

function extractCorrelationIdFromText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = value.match(/Correlation ID:\s*([A-Za-z0-9._-]+)/i);
  return match?.[1] || null;
}

function extractVerificationGates(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const gates = result.verificationGates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return null;
  return gates as Record<string, unknown>;
}

async function resolveEffectiveRuntimeControl(
  userId: string | undefined,
  agentType: 'scribe' | 'trace' | 'proto',
  runtimeOverride?: z.infer<typeof runtimeOverrideSchema>
): Promise<RuntimeControl> {
  if (!userId) {
    return applyRuntimeOverride(DEFAULT_RUNTIME, runtimeOverride);
  }

  const config = await db.query.agentConfigs.findFirst({
    where: and(eq(agentConfigs.userId, userId), eq(agentConfigs.agentType, agentType)),
  });

  const configRuntime = config
    ? ensureRuntimeControl({
        runtimeProfile: (config.runtimeProfile as RuntimeProfile | null) ?? undefined,
        temperatureValue: toNumericOrNull(config.temperatureValue),
        commandLevel: (config.commandLevel as CommandLevel | null) ?? undefined,
        allowCommandExecution:
          typeof config.allowCommandExecution === 'boolean'
            ? config.allowCommandExecution
            : undefined,
        settingsVersion: config.settingsVersion ?? undefined,
      })
    : DEFAULT_RUNTIME;

  return applyRuntimeOverride(configRuntime, runtimeOverride);
}

// Initialize orchestrator (will be injected from server.app.ts)
let orchestrator: AgentOrchestrator;

export function setOrchestrator(orch: AgentOrchestrator): void {
  orchestrator = orch;
}

export async function agentsRoutes(fastify: FastifyInstance) {
  // POST /api/agents/jobs
  fastify.post(
    '/api/agents/jobs',
    {
      schema: {
        description: 'Create and start a new agent job',
        tags: ['agents'],
        body: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['scribe', 'trace', 'proto'] },
            payload: { type: 'object' },
            runtimeOverride: {
              type: 'object',
              properties: {
                runtimeProfile: {
                  type: 'string',
                  enum: ['deterministic', 'balanced', 'creative', 'custom'],
                },
                temperatureValue: { type: 'number', minimum: 0, maximum: 1 },
                commandLevel: { type: 'number', minimum: 1, maximum: 5 },
              },
            },
            requiresStrictValidation: { type: 'boolean', default: false },
            requiresApproval: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              jobId: { type: 'string', format: 'uuid' },
              state: { type: 'string', enum: ['pending', 'running', 'awaiting_approval', 'completed', 'failed'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      let userId: string | undefined;
      try {
        // Validate request body with Zod
        const body = submitJobSchema.parse(request.body);

        // S0.4.6+: Handle config-aware payloads for Scribe
        let enrichedPayload = body.payload;
        let aiModel: string | undefined;
        let aiProvider: string | undefined;
        let effectiveRuntime: RuntimeControl = DEFAULT_RUNTIME;

        if (body.type === 'scribe') {
          try {
            const user = await requireAuth(request);
            userId = user.id;
          } catch (authError) {
            const errorResponse = formatErrorResponse(request, authError);
            reply.code(401).send(errorResponse);
            return;
          }

          if (!userId) {
            throw new Error('Authenticated user id is required for scribe jobs');
          }

          // ========================================================================
          // DUPLICATE RUN PREVENTION
          // Check if there's already a running/pending job for this user + type + repo
          // ========================================================================
          const payloadForDupeCheck = body.payload as Record<string, unknown> | undefined;
          const owner = payloadForDupeCheck?.owner as string | undefined;
          const repo = payloadForDupeCheck?.repo as string | undefined;
          
          if (owner && repo) {
            const existingJob = await db
              .select({
                id: jobs.id,
                state: jobs.state,
                createdAt: jobs.createdAt,
              })
              .from(jobs)
              .where(
                and(
                  inArray(jobs.state, ['pending', 'running']),
                  eq(jobs.type, body.type),
                  sql`(${jobs.payload}->>'userId')::text = ${userId}`,
                  sql`(${jobs.payload}->>'owner')::text = ${owner}`,
                  sql`(${jobs.payload}->>'repo')::text = ${repo}`
                )
              )
              .limit(1);

            if (existingJob.length > 0) {
              const duplicateDetails = {
                existingJobId: existingJob[0].id,
                existingJobState: existingJob[0].state,
                owner,
                repo,
                type: body.type,
              };
              return reply.code(409).send({
                error: {
                  code: 'DUPLICATE_JOB',
                  message: `A ${body.type} job is already running for ${owner}/${repo}. Please wait for it to complete.`,
                  details: duplicateDetails,
                },
                ...duplicateDetails,
              });
            }
          }

          // ========================================================================
          // PROVIDER RESOLUTION (Contract-First)
          // Priority: 1) Frontend payload.aiProvider  2) User activeProvider  3) ENV
          // CRITICAL: Frontend selection MUST be respected - no cross-provider fallback
          // ========================================================================
          const payloadObj = body.payload as Record<string, unknown> | undefined;
          const frontendProvider = payloadObj?.aiProvider as 'openai' | 'anthropic' | 'google' | undefined;

          logger.debug(`[agents.ts] Frontend sent aiProvider: ${frontendProvider || 'none'}`);

          // Load env config for fallback only
          const aiConfig = getAIConfig(getEnv());
          const allowlist = getScribeModelAllowlist();

          // Determine if we should use ENV AI (only when NO frontend provider AND ENV is configured)
          // IMPORTANT: If frontend explicitly sends a provider, we MUST NOT override it with ENV
          const useEnvAI = !frontendProvider &&
                          (aiConfig.provider === 'anthropic' || aiConfig.provider === 'openai' || aiConfig.provider === 'google') &&
                          aiConfig.apiKey;

          logger.debug(`[agents.ts] useEnvAI=${useEnvAI}, envProvider=${aiConfig.provider}, hasEnvKey=${!!aiConfig.apiKey}`);

          if (!useEnvAI && !frontendProvider) {
            // No env AI and no frontend provider - check if user has any key configured
            const [anthropicStatus, openaiStatus, googleStatus] = await Promise.all([
              getUserAiKeyStatus(userId, 'anthropic'),
              getUserAiKeyStatus(userId, 'openai'),
              getUserAiKeyStatus(userId, 'google'),
            ]);
            if (!anthropicStatus.configured && !openaiStatus.configured && !googleStatus.configured) {
              throw new MissingAIKeyError('anthropic', 'No AI provider configured. Please add an API key in Settings > API Keys.');
            }
          }

          if (allowlist.length === 0 && !useEnvAI && !frontendProvider) {
            throw new ModelNotAllowedError('anthropic', 'unknown', allowlist);
          }

          // ========================================================================
          // PROVIDER/MODEL CONSISTENCY VALIDATION
          // Read model from multiple possible field names (frontend sends modelId)
          // ========================================================================
          const frontendModel = payloadObj?.modelId as string | undefined ||
                               payloadObj?.model as string | undefined ||
                               payloadObj?.llmModelOverride as string | undefined;

          logger.debug(`[agents.ts] Frontend sent model: ${frontendModel || 'none'} (checked modelId, model, llmModelOverride)`);

          // Helper to detect provider from model ID
          const detectModelProvider = (model: string): 'openai' | 'anthropic' | 'google' | 'unknown' => {
            if (model.startsWith('gpt-') || model.startsWith('o1') ||
                model.startsWith('text-') || model.startsWith('davinci') ||
                model.startsWith('o3')) {
              return 'openai';
            }
            if (model.startsWith('claude-')) {
              return 'anthropic';
            }
            if (model.startsWith('gemini-')) {
              return 'google';
            }
            return 'unknown';
          };

          if (frontendModel) {
            const detectedModelProvider = detectModelProvider(frontendModel);

            // If no explicit provider from frontend, infer from model
            if (!frontendProvider && detectedModelProvider !== 'unknown') {
              logger.debug(`[agents.ts] Inferring provider from model: ${detectedModelProvider}`);
            }

            // Validate provider-model compatibility — strict cross-provider rejection
            if (frontendProvider && detectedModelProvider !== 'unknown' && detectedModelProvider !== frontendProvider) {
              throw new Error(`Model "${frontendModel}" is a ${detectedModelProvider} model and cannot be used with ${frontendProvider} provider.`);
            }
          }

          if (body.payload && typeof body.payload === 'object') {
            const payload = body.payload as Record<string, unknown>;
            const isConfigAware = 
              payload.mode === 'from_config' || 
              payload.mode === 'test' || 
              payload.mode === 'run' || 
              typeof payload.config_id === 'string';

            // Get model override from payload - check multiple field names
            let modelOverride: string | null = null;
            if (typeof payloadObj?.modelId === 'string') {
              modelOverride = payloadObj.modelId;
            } else if (typeof payloadObj?.model === 'string') {
              modelOverride = payloadObj.model;
            } else if (typeof payloadObj?.llmModelOverride === 'string') {
              modelOverride = payloadObj.llmModelOverride;
            }

            if (isConfigAware) {
              // Load config from DB
              let config;
              try {
                config = await db.query.agentConfigs.findFirst({
                  where: and(
                    eq(agentConfigs.userId, userId),
                    eq(agentConfigs.agentType, 'scribe')
                  ),
                });
              } catch (dbError) {
                throw new Error(`Failed to load Scribe configuration: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
              }

              if (!config) {
                throw new Error('Scribe configuration not found. Please configure Scribe first at /agents/scribe');
              }

              // Validate config has required fields
              if (!config.repositoryOwner || !config.repositoryName || !config.baseBranch) {
                throw new Error('Scribe configuration incomplete. Missing repository owner, name, or base branch. Please complete configuration at /agents/scribe');
              }

              modelOverride = config.llmModelOverride ?? null;

              // Transform config to legacy payload format
              enrichedPayload = {
                ...payload, // Keep mode, dryRun, etc.
                owner: config.repositoryOwner,
                repo: config.repositoryName,
                baseBranch: config.baseBranch,
                userId, // Add userId for orchestrator
              };
              
              // Add optional fields from config
              if (config.branchPattern) {
                (enrichedPayload as Record<string, unknown>).branchPattern = config.branchPattern;
              }
              if (config.targetPlatform) {
                (enrichedPayload as Record<string, unknown>).targetPlatform = config.targetPlatform;
              }
              if (config.targetConfig && typeof config.targetConfig === 'object' && config.targetConfig !== null) {
                (enrichedPayload as Record<string, unknown>).targetConfig = config.targetConfig;
              }
              if (config.prTitleTemplate) {
                (enrichedPayload as Record<string, unknown>).prTitleTemplate = config.prTitleTemplate;
              }
              if (typeof config.prBodyTemplate === 'string' || config.prBodyTemplate === null) {
                (enrichedPayload as Record<string, unknown>).prBodyTemplate = config.prBodyTemplate;
              }
              if (typeof config.autoMerge === 'boolean') {
                (enrichedPayload as Record<string, unknown>).autoMerge = config.autoMerge;
              }
              if (config.triggerMode) {
                (enrichedPayload as Record<string, unknown>).triggerMode = config.triggerMode;
              }
              if (config.scheduleCron) {
                (enrichedPayload as Record<string, unknown>).scheduleCron = config.scheduleCron;
              }
              if (config.includeGlobs && config.includeGlobs.length > 0) {
                (enrichedPayload as Record<string, unknown>).includeGlobs = config.includeGlobs;
              }
              if (config.excludeGlobs && config.excludeGlobs.length > 0) {
                (enrichedPayload as Record<string, unknown>).excludeGlobs = config.excludeGlobs;
              }
            } else {
              // Legacy payload: enrich with userId and auto-generate branch if not provided
              enrichedPayload = { ...payload, userId };
              
              // Auto-generate feature branch if not provided
              if (!payload.featureBranch) {
                (enrichedPayload as Record<string, unknown>).featureBranch = generateScribeBranchName();
              }
              
              if (typeof payload.llmModelOverride === 'string') {
                modelOverride = payload.llmModelOverride;
              }
              if (typeof payload.model === 'string') {
                modelOverride = payload.model;
              }
            }

            // ========================================================================
            // AI MODEL + PROVIDER RESOLUTION
            // CRITICAL: Frontend provider selection takes absolute priority
            // Model must be compatible with selected provider
            // ========================================================================
            
            // Helper to get provider-safe model
            const getProviderSafeModel = (provider: 'openai' | 'anthropic' | 'google', requestedModel: string | null): string => {
              if (!requestedModel) {
                return RECOMMENDED_MODELS[provider];
              }

              const modelProvider = detectModelProvider(requestedModel);

              // If model is compatible with provider, use it
              if (modelProvider === 'unknown' || modelProvider === provider) {
                return requestedModel;
              }

              // Model is incompatible - use provider's default and log
              logger.debug(`[agents.ts] Model "${requestedModel}" (${modelProvider}) incompatible with ${provider}, using default: ${RECOMMENDED_MODELS[provider]}`);
              return RECOMMENDED_MODELS[provider];
            };

            // Determine the effective provider
            if (frontendProvider) {
              // Frontend explicitly selected a provider - respect it completely
              aiProvider = frontendProvider;

              // Ensure model is compatible with provider
              aiModel = getProviderSafeModel(frontendProvider, modelOverride);

              logger.debug(`[agents.ts] Using frontend provider: ${aiProvider}, model: ${aiModel}`);
            } else if (useEnvAI) {
              // No frontend provider, use env-based AI configuration
              const envProvider = aiConfig.provider === 'openai' || aiConfig.provider === 'anthropic' || aiConfig.provider === 'google'
                ? aiConfig.provider
                : 'anthropic';
              aiProvider = envProvider;
              aiModel = getProviderSafeModel(envProvider, modelOverride || aiConfig.modelDefault);
              logger.debug(`[agents.ts] Using ENV provider: ${aiProvider}, model: ${aiModel}`);
            } else {
              // No frontend provider, no env - infer from model if possible
              if (modelOverride) {
                const inferredProvider = detectModelProvider(modelOverride);
                if (inferredProvider !== 'unknown') {
                  aiProvider = inferredProvider;
                  aiModel = modelOverride;
                  logger.debug(`[agents.ts] Inferred provider from model: ${aiProvider}, model: ${aiModel}`);
                } else {
                  // Can't infer - let orchestrator resolve
                  aiProvider = undefined;
                  aiModel = modelOverride;
                  logger.debug(`[agents.ts] Deferring to orchestrator, model: ${aiModel}`);
                }
              } else {
                // No model override - let orchestrator resolve
                aiProvider = undefined;
                aiModel = allowlist[0] || 'gpt-4o-mini';
                logger.debug(`[agents.ts] Deferring to orchestrator, model: ${aiModel}`);
              }
            }
            
            // Add aiProvider to payload - orchestrator will see this as payloadProvider
            enrichedPayload = {
              ...(enrichedPayload as Record<string, unknown>),
              llmModelOverride: aiModel,
              useEnvAI: useEnvAI || false,
              aiProvider: aiProvider, // This is now frontend's choice, not overwritten
            };
            
            logger.debug(`[agents.ts] Final enrichedPayload.aiProvider: ${(enrichedPayload as Record<string, unknown>).aiProvider}`);
            logger.debug(`[agents.ts] Final enrichedPayload.llmModelOverride: ${(enrichedPayload as Record<string, unknown>).llmModelOverride}`);
          }
        }

        // For non-scribe agents, inject userId and AI provider config from auth session
        if (body.type !== 'scribe') {
          try {
            const user = await requireAuth(request);
            userId = user.id;
          } catch {
            // Auth optional for non-scribe — orchestrator will fail-fast if GitHub needed
          }

          if (userId && enrichedPayload && typeof enrichedPayload === 'object') {
            const payloadObj = enrichedPayload as Record<string, unknown>;
            enrichedPayload = { ...payloadObj, userId };

            // Map frontend AI config fields so orchestrator can resolve user keys
            // Frontend sends modelId but orchestrator reads llmModelOverride
            if (payloadObj.modelId && !payloadObj.llmModelOverride) {
              (enrichedPayload as Record<string, unknown>).llmModelOverride = payloadObj.modelId;
            }
            // Propagate aiProvider from frontend to top-level for job record
            if (payloadObj.aiProvider && !aiProvider) {
              aiProvider = payloadObj.aiProvider as string;
            }
            // Propagate model for job record
            if (payloadObj.modelId && !aiModel) {
              aiModel = payloadObj.modelId as string;
            }
          } else if (userId && !enrichedPayload) {
            enrichedPayload = { userId };
          }
        }

        if (userId) {
          const [activeRunsRow] = await db
            .select({
              count: sql<number>`count(*)`,
            })
            .from(jobs)
            .where(
              and(
                inArray(jobs.state, ['pending', 'running']),
                sql`(${jobs.payload}->>'userId')::text = ${userId}`
              )
            );
          const activeRuns = Number(activeRunsRow?.count ?? 0);
          if (activeRuns >= MAX_ACTIVE_RUNS_PER_USER) {
            return reply.code(429).send({
              error: {
                code: 'ACTIVE_RUN_LIMIT_EXCEEDED',
                message: `Maximum ${MAX_ACTIVE_RUNS_PER_USER} active runs are allowed per user.`,
              },
              activeRuns,
              limit: MAX_ACTIVE_RUNS_PER_USER,
            });
          }
        }

        effectiveRuntime = await resolveEffectiveRuntimeControl(userId, body.type, body.runtimeOverride);
        if (enrichedPayload && typeof enrichedPayload === 'object') {
          enrichedPayload = {
            ...(enrichedPayload as Record<string, unknown>),
            runtimeOverride: body.runtimeOverride ?? null,
            effectiveRuntime,
          };
        } else {
          enrichedPayload = {
            runtimeOverride: body.runtimeOverride ?? null,
            effectiveRuntime,
            ...(userId ? { userId } : {}),
          };
        }

        // Submit job (creates DB row with pending state)
        const jobId = await orchestrator.submitJob({
          type: body.type,
          payload: enrichedPayload,
          requiresStrictValidation: body.requiresStrictValidation,
          requiresApproval: body.requiresApproval,
          aiModel,
          aiProvider,
        });

        // Phase 7.B: Record job created metric
        metrics.jobsCreated.inc({ type: body.type });

        const jobApiStart = Date.now();
        pushLog({ jobId, agentType: body.type, userId: userId || null, msg: 'job_started', level: 30 });
        fastify.log?.info({ jobId, agentType: body.type, userId: userId || null, msg: 'job_started' });

        // Start job immediately (executes agent and transitions to completed/failed)
        let finalState = 'pending';
        try {
          await orchestrator.startJob(jobId);
          const durationMs = Date.now() - jobApiStart;
          // Query final state after execution
          const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
          if (job) {
            finalState = job.state;
            // Phase 7.B: Record job completion/failure metrics
            if (finalState === 'completed') {
              metrics.jobsCompleted.inc({ type: body.type });
            } else if (finalState === 'failed') {
              metrics.jobsFailed.inc({ type: body.type });
            }
          }
          pushLog({ jobId, agentType: body.type, userId: userId || null, durationMs, state: finalState, msg: 'job_completed', level: 30 });
          fastify.log?.info({ jobId, agentType: body.type, userId: userId || null, durationMs, state: finalState, msg: 'job_completed' });
        } catch (_startError) {
          const durationMs = Date.now() - jobApiStart;
          pushLog({ jobId, agentType: body.type, userId: userId || null, durationMs, err: _startError, msg: 'job_start_failed', level: 50 });
          (fastify.log as { warn?: (o: object, m?: string) => void })?.warn?.({ jobId, agentType: body.type, userId: userId || null, durationMs, err: _startError, msg: 'job_start_failed' });
          // If start fails, job is already marked as failed in DB
          try {
            const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
            if (job) {
              finalState = job.state;
              if (finalState === 'failed') {
                metrics.jobsFailed.inc({ type: body.type });
              }
            }
          } catch {
            // If we can't query, default to pending
          }
        }

        return { jobId, state: finalState };
      } catch (error) {
        // Phase 7.E: Use unified error model
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        const routeForError = request.routeOptions?.url ?? request.url.split('?')[0];
        const userIdForError = userId;
        pushLog({
          requestId: request.id,
          userId: userIdForError || null,
          route: routeForError,
          err: error instanceof Error ? error : new Error(String(error)),
          msg: 'job_submit_error',
          level: 60,
        });
        fastify.log?.error({
          requestId: request.id,
          userId: userIdForError || null,
          route: routeForError,
          err: error instanceof Error ? error : new Error(String(error)),
          msg: 'job_submit_error',
        });
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // GET /api/agents/jobs/:id
  fastify.get(
    '/api/agents/jobs/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            include: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const params = jobIdParamsSchema.parse(request.params);
        const query = includeQuerySchema.parse(request.query || {});

        // Parse include flags
        const includeFlags = query.include
          ? query.include.split(',').map((s) => s.trim().toLowerCase())
          : [];
        const includePlan = includeFlags.includes('plan');
        const includeAudit = includeFlags.includes('audit');
        const includeTrace = includeFlags.includes('trace');
        const includeArtifacts = includeFlags.includes('artifacts');

        // Fetch job from database
        let job;
        try {
          const result = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
          if (!result.length) {
            const errorResponse = formatErrorResponse(request, new JobNotFoundError(params.id));
            reply.code(404).send(errorResponse);
            return;
          }
          job = result[0];
          if (!isJobOwnedByUser(job.payload, user.id)) {
            return sendJobNotFound(reply, params.id, request.id);
          }
        } catch (error) {
          const errorResponse = formatErrorResponse(request, error);
          const statusCode = getStatusCodeForError(errorResponse.error.code);
          reply.code(statusCode).send(errorResponse);
          return;
        }

        // Phase 5.F: Fetch plan if requested
        let plan = null;
        if (includePlan) {
          try {
            const [planRow] = await db
              .select()
              .from(jobPlans)
              .where(eq(jobPlans.jobId, params.id))
              .limit(1);
            if (planRow) {
              plan = {
                steps: planRow.steps,
                rationale: planRow.rationale,
                createdAt: planRow.createdAt,
              };
            }
          } catch (error) {
            // Don't fail request if plan fetch fails
            logger.error(`Failed to fetch plan for job ${params.id}: ${error}`);
          }
        }

        // Phase 5.F: Fetch audit entries if requested
        let audits: unknown[] = [];
        if (includeAudit) {
          try {
            const auditRows = await db
              .select()
              .from(jobAudits)
              .where(eq(jobAudits.jobId, params.id))
              .orderBy(desc(jobAudits.createdAt))
              .limit(50); // Limit to recent 50 audits
            audits = auditRows.map((row) => ({
              phase: row.phase,
              payload: row.payload,
              createdAt: row.createdAt,
            }));
          } catch (error) {
            // Don't fail request if audit fetch fails
            logger.error(`Failed to fetch audits for job ${params.id}: ${error}`);
          }
        }

        // S1.0: Fetch trace events if requested
        let traces: unknown[] = [];
        if (includeTrace) {
          try {
            const traceRows = await db
              .select()
              .from(jobTraces)
              .where(eq(jobTraces.jobId, params.id))
              .orderBy(asc(jobTraces.timestamp))
              .limit(500); // Limit to 500 trace events
            traces = traceRows.map((row) => ({
              id: row.id,
              eventType: row.eventType,
              stepId: row.stepId,
              title: row.title,
              detail: row.detail,
              durationMs: row.durationMs,
              status: row.status,
              correlationId: row.correlationId,
              gatewayUrl: row.gatewayUrl,
              errorCode: row.errorCode,
              timestamp: row.timestamp,
            }));
          } catch (error) {
            // Don't fail request if trace fetch fails
            logger.error(`Failed to fetch traces for job ${params.id}: ${error}`);
          }
        }

        // S1.0: Fetch artifacts if requested
        let artifacts: unknown[] = [];
        if (includeArtifacts) {
          try {
            const artifactRows = await db
              .select()
              .from(jobArtifacts)
              .where(eq(jobArtifacts.jobId, params.id))
              .orderBy(asc(jobArtifacts.createdAt))
              .limit(100); // Limit to 100 artifacts
            artifacts = artifactRows.map((row) => ({
              id: row.id,
              artifactType: row.artifactType,
              path: row.path,
              operation: row.operation,
              sizeBytes: row.sizeBytes,
              contentHash: row.contentHash,
              preview: row.preview,
              metadata: row.metadata,
              createdAt: row.createdAt,
            }));
          } catch (error) {
            // Don't fail request if artifacts fetch fails
            logger.error(`Failed to fetch artifacts for job ${params.id}: ${error}`);
          }
        }

        // Fetch per-call AI metrics if traces are requested
        let aiCalls: Array<{
          id: string;
          callIndex: number;
          provider: string;
          model: string;
          purpose: string | null;
          inputTokens: number | null;
          outputTokens: number | null;
          totalTokens: number | null;
          durationMs: number | null;
          estimatedCostUsd: string | null;
          success: boolean;
          errorCode: string | null;
          timestamp: Date;
        }> = [];

        if (includeTrace) {
          try {
            const aiCallRows = await db
              .select()
              .from(jobAiCalls)
              .where(eq(jobAiCalls.jobId, params.id))
              .orderBy(asc(jobAiCalls.callIndex));
            aiCalls = aiCallRows.map((row) => ({
              id: row.id,
              callIndex: row.callIndex,
              provider: row.provider,
              model: row.model,
              purpose: row.purpose,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              totalTokens: row.totalTokens,
              durationMs: row.durationMs,
              estimatedCostUsd: row.estimatedCostUsd,
              success: row.success,
              errorCode: row.errorCode,
              timestamp: row.timestamp,
            }));
          } catch (error) {
            logger.error(`Failed to fetch AI calls for job ${params.id}: ${error}`);
          }
        }

        // Return job data with optional plan/audit/trace/artifacts
        const correlationId =
          extractCorrelationIdFromText(job.errorMessage) || extractCorrelationIdFromText(job.error);
        const verificationGates = extractVerificationGates(job.result);
        const payloadAsRecord =
          job.payload && typeof job.payload === 'object'
            ? (job.payload as Record<string, unknown>)
            : null;
        const effectiveRuntime = ensureRuntimeControl(
          (payloadAsRecord?.effectiveRuntime as Partial<RuntimeControl> | undefined) ?? undefined
        );

        // Build structured AI response object
        const aiResponse = {
          // Requested (what was originally submitted)
          requested: {
            provider: job.aiProvider,
            model: job.aiModel,
          },
          // Resolved (what was actually used at runtime)
          resolved: {
            provider: job.aiProviderResolved,
            model: job.aiModelResolved,
            keySource: job.aiKeySource,
            fallbackReason: job.aiFallbackReason,
          },
          // Summary (aggregate metrics)
          summary: {
            totalDurationMs: job.aiTotalDurationMs,
            inputTokens: job.aiInputTokens,
            outputTokens: job.aiOutputTokens,
            totalTokens: job.aiTotalTokens,
            estimatedCostUsd: job.aiEstimatedCostUsd,
          },
          // Per-call breakdown (if includeTrace)
          calls: aiCalls,
        };

        const response: Record<string, unknown> = {
          id: job.id,
          type: job.type,
          state: job.state,
          payload: job.payload,
          result: job.result,
          error: job.error,
          errorCode: job.errorCode,
          errorMessage: job.errorMessage,
          rawErrorPayload: job.rawErrorPayload,
          mcpGatewayUrl: job.mcpGatewayUrl,
          // Legacy fields (keep for backward compatibility)
          aiProvider: job.aiProvider,
          aiModel: job.aiModel,
          aiTotalDurationMs: job.aiTotalDurationMs,
          aiInputTokens: job.aiInputTokens,
          aiOutputTokens: job.aiOutputTokens,
          aiTotalTokens: job.aiTotalTokens,
          aiEstimatedCostUsd: job.aiEstimatedCostUsd,
          // New structured AI object
          ai: aiResponse,
          effectiveRuntime,
          correlationId,
          // Quality fields (persisted)
          qualityScore: job.qualityScore,
          qualityBreakdown: job.qualityBreakdown,
          qualityVersion: job.qualityVersion,
          qualityComputedAt: job.qualityComputedAt,
          verificationGates,
          // Quality suggestions (computed on-the-fly if quality exists)
          qualitySuggestions: job.qualityBreakdown && job.qualityScore !== null
            ? generateQualitySuggestions(
                {
                  score: job.qualityScore,
                  breakdown: job.qualityBreakdown as { label: string; value: string; points: number }[],
                  version: job.qualityVersion || 'v1.0',
                  computedAt: job.qualityComputedAt || new Date(),
                } as QualityResult,
                {
                  jobType: job.type,
                  state: job.state === 'completed' ? 'completed' : 'failed',
                  errorCode: job.errorCode,
                  targetsConfigured: ((job.payload as Record<string, unknown>)?.outputTargets as string[]) || [],
                  targetsProduced: [],
                  documentsRead: 0,
                  filesProduced: 0,
                  docDepth: ((job.payload as Record<string, unknown>)?.docDepth as 'lite' | 'standard' | 'deep') || 'standard',
                  multiPass: ((job.payload as Record<string, unknown>)?.multiPass as boolean) || false,
                } as QualityInput
              )
            : [],
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        };

        if (includePlan) {
          response.plan = plan;
        }
        if (includeAudit) {
          response.audit = audits;
        }
        if (includeTrace) {
          response.trace = traces;
        }
        if (includeArtifacts) {
          response.artifacts = artifacts;
        }

        return response;
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // Phase 7.D: GET /api/agents/jobs - List jobs with filtering and pagination
  // Cursor encoding: base64(createdAt|id) for deterministic pagination
const jobsListQuerySchema = z.object({
  type: z.enum(['scribe', 'trace', 'proto']).optional(),
  state: z.enum(['pending', 'running', 'awaiting_approval', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(), // base64 encoded cursor
});

  fastify.get(
    '/api/agents/jobs',
    {
      schema: {
        description: 'List jobs with filtering and cursor pagination',
        tags: ['agents'],
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['scribe', 'trace', 'proto'] },
            state: { type: 'string', enum: ['pending', 'running', 'awaiting_approval', 'completed', 'failed'] },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', description: 'Base64-encoded cursor for pagination (format: base64(createdAt|id))' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    type: { type: 'string' },
                    state: { type: 'string' },
                    errorCode: { type: 'string', nullable: true },
                    errorMessage: { type: 'string', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              nextCursor: { type: 'string', format: 'uuid', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const query = jobsListQuerySchema.parse(request.query || {});

        // Build where clause - always filter by userId for user isolation
        const conditions = [sql`(${jobs.payload}->>'userId')::text = ${user.id}`];
        if (query.type) {
          conditions.push(eq(jobs.type, query.type));
        }
        if (query.state) {
          conditions.push(eq(jobs.state, query.state));
        }
        if (query.cursor) {
          // Decode cursor: base64(createdAt|id)
          try {
            const decoded = Buffer.from(query.cursor, 'base64').toString('utf-8');
            const [cursorCreatedAt, cursorId] = decoded.split('|');
            if (cursorCreatedAt && cursorId) {
              // Get jobs with createdAt < cursorCreatedAt OR (createdAt = cursorCreatedAt AND id < cursorId)
              conditions.push(
                sql`${jobs.createdAt} < ${cursorCreatedAt}::timestamp OR (${jobs.createdAt} = ${cursorCreatedAt}::timestamp AND ${jobs.id} < ${cursorId}::uuid)`
              );
            }
          } catch {
            // Invalid cursor format - ignore cursor and return first page
          }
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        // Fetch jobs ordered by createdAt DESC
        const limit = query.limit + 1; // Fetch one extra to determine if there's a next page
        const jobRows = await db
          .select({
            id: jobs.id,
            type: jobs.type,
            state: jobs.state,
            errorCode: jobs.errorCode,
            errorMessage: jobs.errorMessage,
            qualityScore: jobs.qualityScore,
            createdAt: jobs.createdAt,
            updatedAt: jobs.updatedAt,
          })
          .from(jobs)
          .where(whereClause)
          .orderBy(desc(jobs.createdAt), desc(jobs.id))
          .limit(limit);

        // Determine next cursor: base64(createdAt|id) of the last item
        let nextCursor: string | null = null;
        if (jobRows.length > query.limit) {
          // There's a next page - encode cursor from last item
          const lastJob = jobRows[query.limit - 1];
          const cursorValue = `${lastJob.createdAt.toISOString()}|${lastJob.id}`;
          nextCursor = Buffer.from(cursorValue, 'utf-8').toString('base64');
          jobRows.pop(); // Remove the extra item
        }

        return {
          items: jobRows,
          nextCursor,
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // GET /api/agents/jobs/running - Get currently running jobs for the authenticated user
  // Used for: live progress display, duplicate run prevention
  fastify.get(
    '/api/agents/jobs/running',
    {
      schema: {
        description: 'Get currently running or pending jobs for the authenticated user',
        tags: ['agents'],
        response: {
          200: {
            type: 'object',
            properties: {
              jobs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    type: { type: 'string', enum: ['scribe', 'trace', 'proto'] },
                    state: { type: 'string', enum: ['pending', 'running', 'awaiting_approval'] },
                    payload: { type: 'object' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    latestTrace: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        title: { type: 'string' },
                        detail: { type: 'string', nullable: true },
                        timestamp: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Require authentication
        const user = await requireAuth(request);

        // Fetch running/pending jobs for this user
        // We need to join with payload to filter by userId in payload
        const runningJobs = await db
          .select({
            id: jobs.id,
            type: jobs.type,
            state: jobs.state,
            payload: jobs.payload,
            createdAt: jobs.createdAt,
            updatedAt: jobs.updatedAt,
          })
          .from(jobs)
          .where(
            and(
              inArray(jobs.state, ['pending', 'running', 'awaiting_approval']),
              // Filter by userId in payload JSON
              sql`(${jobs.payload}->>'userId')::text = ${user.id}`
            )
          )
          .orderBy(desc(jobs.createdAt))
          .limit(10); // Limit to 10 active jobs

        // For each job, get the latest trace event
        const jobsWithTrace = await Promise.all(
          runningJobs.map(async (job) => {
            let latestTrace = null;
            try {
              const [trace] = await db
                .select({
                  title: jobTraces.title,
                  detail: jobTraces.detail,
                  timestamp: jobTraces.timestamp,
                })
                .from(jobTraces)
                .where(eq(jobTraces.jobId, job.id))
                .orderBy(desc(jobTraces.timestamp))
                .limit(1);
              
              if (trace) {
                latestTrace = {
                  title: trace.title,
                  detail: trace.detail,
                  timestamp: trace.timestamp,
                };
              }
            } catch {
              // Ignore trace fetch errors
            }

            return {
              ...job,
              latestTrace,
            };
          })
        );

        return { jobs: jobsWithTrace };
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // POST /api/agents/jobs/:id/approve - Approve a job for execution (S1.2)
  fastify.post(
    '/api/agents/jobs/:id/approve',
    {
      schema: {
        description: 'Approve a PLAN_ONLY job for execution',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            comment: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Require authentication
        const user = await requireAuth(request);

        // Validate params
        const params = jobIdParamsSchema.parse(request.params);
        const body = request.body as { comment?: string };

        // Load job
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Validate approval eligibility
        if (!job.requiresApproval) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_OPERATION',
              message: 'This job does not require approval',
            },
          });
        }

        if (job.state !== 'awaiting_approval') {
          return reply.code(400).send({
            error: {
              code: 'INVALID_STATE',
              message: `Job is in state "${job.state}" and cannot be approved. Only jobs in "awaiting_approval" state can be approved.`,
            },
          });
        }

        if (job.approvedBy || job.approvedAt) {
          return reply.code(400).send({
            error: {
              code: 'ALREADY_APPROVED',
              message: 'This job has already been approved',
            },
          });
        }

        // Update job with approval info
        const approvedAt = new Date();
        await db
          .update(jobs)
          .set({
            approvedBy: user.id,
            approvedAt,
            approvalComment: body.comment || null,
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, params.id));

        // PR-1: Resume job execution after approval
        try {
          await orchestrator.resumeApprovedJob(params.id);
        } catch (resumeError) {
          // Log but don't fail the approval - job is still marked approved
          logger.error(`Failed to resume job ${params.id} after approval: ${resumeError}`);
        }

        return reply.code(200).send({
          success: true,
          message: 'Job approved successfully. Execution resumed.',
          approvedBy: user.id,
          approvedAt: approvedAt.toISOString(),
        });
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // POST /api/agents/jobs/:id/reject - Reject a job (S1.2)
  fastify.post(
    '/api/agents/jobs/:id/reject',
    {
      schema: {
        description: 'Reject a PLAN_ONLY job',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            comment: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Require authentication
        const user = await requireAuth(request);

        // Validate params
        const params = jobIdParamsSchema.parse(request.params);
        const body = request.body as { comment?: string };

        // Load job
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Validate rejection eligibility
        if (!job.requiresApproval) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_OPERATION',
              message: 'This job does not require approval',
            },
          });
        }

        if (job.state !== 'awaiting_approval') {
          return reply.code(400).send({
            error: {
              code: 'INVALID_STATE',
              message: `Job is in state "${job.state}" and cannot be rejected. Only jobs in "awaiting_approval" state can be rejected.`,
            },
          });
        }

        // Update job with rejection info
        await db
          .update(jobs)
          .set({
            rejectedBy: user.id,
            rejectedAt: new Date(),
            approvalComment: body.comment || null,
            state: 'failed', // Mark as failed since it won't be executed
            error: 'Job rejected by user',
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, params.id));

        return reply.code(200).send({
          success: true,
          message: 'Job rejected successfully',
          rejectedBy: user.id,
          rejectedAt: new Date().toISOString(),
        });
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // ============================================================================
  // PR-2: Feedback Loop - Comments & Revisions
  // ============================================================================

  // GET /api/agents/jobs/:id/comments - Get job comments
  fastify.get(
    '/api/agents/jobs/:id/comments',
    {
      schema: {
        description: 'Get all comments for a job',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const params = jobIdParamsSchema.parse(request.params);

        // Verify job exists
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Get comments
        const comments = await db
          .select()
          .from(jobComments)
          .where(eq(jobComments.jobId, params.id))
          .orderBy(asc(jobComments.createdAt));

        return { comments };
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // POST /api/agents/jobs/:id/comments - Add a comment to a job
  fastify.post(
    '/api/agents/jobs/:id/comments',
    {
      schema: {
        description: 'Add a comment to a job (PR-2 feedback loop)',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Require authentication
        const user = await requireAuth(request);

        const params = jobIdParamsSchema.parse(request.params);
        const body = request.body as { text: string };

        // Verify job exists
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Insert comment
        const [comment] = await db
          .insert(jobComments)
          .values({
            jobId: params.id,
            userId: user.id,
            commentText: body.text,
          })
          .returning();

        // Record audit event
        await db.insert(jobAudits).values({
          jobId: params.id,
          phase: 'execute', // Use execute phase for user feedback
          payload: {
            type: 'USER_COMMENT_ADDED',
            commentId: comment.id,
            userId: user.id,
            textPreview: body.text.substring(0, 100),
          },
        });

        return reply.code(201).send({
          success: true,
          comment: {
            id: comment.id,
            jobId: comment.jobId,
            userId: comment.userId,
            text: comment.commentText,
            createdAt: comment.createdAt,
          },
        });
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // POST /api/agents/jobs/:id/revise - Request a revision (create new job with parent link)
  fastify.post(
    '/api/agents/jobs/:id/revise',
    {
      schema: {
        description: 'Request a revision of a completed job (PR-2 feedback loop)',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['instruction'],
          properties: {
            instruction: { type: 'string', minLength: 1, maxLength: 5000 },
            mode: { type: 'string', enum: ['edit', 'regenerate'], default: 'edit' },
            scope: { type: 'string', enum: ['files', 'plan', 'both'], default: 'files' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Require authentication
        const user = await requireAuth(request);

        const params = jobIdParamsSchema.parse(request.params);
        const body = request.body as { instruction: string; mode?: string; scope?: string };

        // Load parent job
        const [parentJob] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!parentJob) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(parentJob.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Validate parent job is completed or failed (can revise either)
        if (parentJob.state !== 'completed' && parentJob.state !== 'failed') {
          return reply.code(400).send({
            error: {
              code: 'INVALID_STATE',
              message: `Cannot revise a job in state "${parentJob.state}". Only completed or failed jobs can be revised.`,
            },
          });
        }

        // Get parent job's artifacts (files produced)
        const parentArtifacts = await db
          .select()
          .from(jobArtifacts)
          .where(eq(jobArtifacts.jobId, params.id));

        // Get parent job's comments (as context)
        const parentComments = await db
          .select()
          .from(jobComments)
          .where(eq(jobComments.jobId, params.id))
          .orderBy(asc(jobComments.createdAt));

        // Build enhanced payload for revision job
        const parentPayload = (parentJob.payload || {}) as Record<string, unknown>;
        const revisionPayload = {
          ...parentPayload,
          // Add revision context
          revisionContext: {
            parentJobId: params.id,
            instruction: body.instruction,
            mode: body.mode || 'edit',
            scope: body.scope || 'files',
            // Include parent artifacts as documents to edit
            parentArtifacts: parentArtifacts.map(a => ({
              type: a.artifactType,
              path: a.path,
              operation: a.operation,
              preview: a.preview,
              metadata: a.metadata,
            })),
            // Include parent comments as feedback context
            feedbackComments: parentComments.map(c => ({
              text: c.commentText,
              createdAt: c.createdAt,
            })),
          },
          // Ensure userId is set
          userId: user.id,
        };

        // Create revision job
        const newJobId = await orchestrator.submitJob({
          type: parentJob.type,
          payload: revisionPayload,
          requiresStrictValidation: parentJob.requiresStrictValidation,
          aiModel: parentJob.aiModel ?? undefined,
          aiProvider: parentJob.aiProvider ?? undefined,
        });

        // Update revision job with parent reference
        await db
          .update(jobs)
          .set({
            parentJobId: params.id,
            revisionNote: body.instruction,
          })
          .where(eq(jobs.id, newJobId));

        // Record audit event on parent
        await db.insert(jobAudits).values({
          jobId: params.id,
          phase: 'execute',
          payload: {
            type: 'REVISION_REQUESTED',
            childJobId: newJobId,
            instruction: body.instruction.substring(0, 200),
            mode: body.mode || 'edit',
            requestedBy: user.id,
          },
        });

        // Start the revision job
        try {
          await orchestrator.startJob(newJobId);
        } catch (startError) {
          logger.error(`Failed to start revision job ${newJobId}: ${startError}`);
          // Job is still created, user can retry
        }

        return reply.code(201).send({
          success: true,
          message: 'Revision job created',
          newJobId,
          parentJobId: params.id,
        });
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  // GET /api/agents/jobs/:id/revisions - Get revision chain (children of this job)
  fastify.get(
    '/api/agents/jobs/:id/revisions',
    {
      schema: {
        description: 'Get revision chain for a job (child jobs)',
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const params = jobIdParamsSchema.parse(request.params);

        // Verify job exists
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Get child revisions
        const revisions = await db
          .select({
            id: jobs.id,
            state: jobs.state,
            revisionNote: jobs.revisionNote,
            createdAt: jobs.createdAt,
            completedAt: jobs.updatedAt,
          })
          .from(jobs)
          .where(eq(jobs.parentJobId, params.id))
          .orderBy(desc(jobs.createdAt));

        // Get parent job if this is a revision
        let parentJob = null;
        if (job.parentJobId) {
          const [parent] = await db
            .select({
              id: jobs.id,
              state: jobs.state,
              createdAt: jobs.createdAt,
            })
            .from(jobs)
            .where(eq(jobs.id, job.parentJobId))
            .limit(1);
          parentJob = parent || null;
        }

        return {
          parentJob,
          revisions,
          isRevision: Boolean(job.parentJobId),
          revisionNote: job.revisionNote,
        };
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );

  /**
   * POST /api/agents/jobs/:id/cancel - Cancel a running or pending job
   * S2.0.2: Cancel semantics for job lifecycle control
   */
  fastify.post(
    '/api/agents/jobs/:id/cancel',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['agents'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              state: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await requireAuth(request);
        const params = jobIdParamsSchema.parse(request.params);

        // Fetch job
        const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (!job) {
          throw new JobNotFoundError(params.id);
        }
        if (!isJobOwnedByUser(job.payload, user.id)) {
          return sendJobNotFound(reply, params.id, request.id);
        }

        // Check if job can be cancelled (only pending or running)
        if (job.state !== 'pending' && job.state !== 'running') {
          return reply.code(409).send({
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: `Cannot cancel job in ${job.state} state`,
              timestamp: new Date().toISOString(),
              path: request.url,
            },
          });
        }

        // Update job to failed state (cancel = graceful fail)
        await db
          .update(jobs)
          .set({
            state: 'failed',
            error: 'Job cancelled by user',
            errorCode: 'JOB_CANCELLED',
            errorMessage: 'Job was cancelled by user request',
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, params.id));

        metrics.jobsCancelled.inc({ type: job.type });

        return {
          id: params.id,
          state: 'failed',
          message: 'Job cancelled successfully',
        };
      } catch (error) {
        const errorResponse = formatErrorResponse(request, error);
        const statusCode = getStatusCodeForError(errorResponse.error.code);
        reply.code(statusCode).send(errorResponse);
      }
    }
  );
}
