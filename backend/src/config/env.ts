import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

// =============================================================================
// ENV LOADING (Correct Precedence)
// =============================================================================
// Priority: 1) Shell exports  2) .env.local  3) .env
// .env.local overrides .env, but shell exports override both
// =============================================================================

// Get backend directory (where .env files are located)
const backendDir = resolve(import.meta.dirname, '../../');

// Snapshot shell exports so they keep precedence over .env / .env.local
// (matches the stated priority: shell > .env.local > .env).
const shellExports = { ...process.env };

// Load .env first — override: true ensures .env values take precedence
// over inherited shell environment (e.g., Claude Desktop sets NODE_ENV=production)
loadEnv({ path: resolve(backendDir, '.env'), override: true });

// Load .env.local second (local overrides) - this WILL override .env values
loadEnv({ path: resolve(backendDir, '.env.local'), override: true });

// Restore shell-exported values so explicit shell env wins.
for (const [key, value] of Object.entries(shellExports)) {
  if (value !== undefined) process.env[key] = value;
}

/**
 * Environment schema validation (fail-fast)
 * Atlassian vars are optional in development unless MCP_ATLASSIAN_ENABLED=true
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    AKIS_HOST: z.string().default('0.0.0.0'),
    AKIS_PORT: z.coerce.number().default(3000),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    BACKEND_URL: z.string().url().default('http://localhost:3000'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      ),
    DATABASE_URL: z.string().url(),
    POSTGRES_HOST: z.string().default('localhost'),
    POSTGRES_PORT: z.coerce.number().default(5433),
    POSTGRES_DB: z.string().default('akis_v2'),
    POSTGRES_USER: z.string().default('postgres'),
    POSTGRES_PASSWORD: z.string().default('postgres'),
    AUTH_COOKIE_NAME: z.string().default('akis_sid'),
    AUTH_COOKIE_MAXAGE: z.coerce.number().default(60 * 60 * 24 * 7), // 7 days in seconds
    AUTH_COOKIE_SAMESITE: z
      .enum(['Lax', 'Strict', 'None', 'lax', 'strict', 'none'])
      .default('Lax')
      .transform((value) => value.toLowerCase() as 'lax' | 'strict' | 'none'),
    AUTH_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AUTH_COOKIE_DOMAIN: z.string().optional(),
    AUTH_JWT_SECRET: z
      .string()
      .min(32, 'AUTH_JWT_SECRET must be at least 32 characters long')
      .optional(),
    // Email configuration
    EMAIL_PROVIDER: z.enum(['mock', 'resend', 'smtp']).default('mock'),
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().email().optional(),
    EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().default(15),
    // SMTP configuration (used when EMAIL_PROVIDER=smtp)
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SMTP_FROM_NAME: z.string().default('AKIS Platform'),
    SMTP_FROM_EMAIL: z.string().optional(),
    SMTP_REPLY_TO: z.string().optional(),
    PUBLIC_LOGO_URL: z.string().optional(),
    // OAuth Configuration (S0.4.2)
    // OAuth credentials for user login (separate from GitHub App credentials)
    GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
    APP_PUBLIC_URL: z.preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.string().url().optional()
    ),
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    // Atlassian OAuth 2.0 (3LO) Configuration
    // For Jira + Confluence integration via OAuth
    ATLASSIAN_OAUTH_CLIENT_ID: z.string().optional(),
    ATLASSIAN_OAUTH_CLIENT_SECRET: z.string().optional(),
    ATLASSIAN_OAUTH_CALLBACK_URL: z
      .string()
      .url()
      .optional()
      .default('http://localhost:3000/api/integrations/atlassian/oauth/callback'),
    // GitHub App Configuration (MCP Integration)
    // These are for GitHub App installation, NOT for OAuth user login
    // Preprocess empty strings to undefined to handle test environments
    GITHUB_MCP_BASE_URL: z.preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.string().url().optional()
    ),
    ATLASSIAN_MCP_BASE_URL: z.preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.string().url().optional()
    ),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_INSTALLATION_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_PEM: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(), // Personal Access Token for MVP/Dev
    SCRIBE_DEV_GITHUB_BOOTSTRAP: z.enum(['true', 'false']).default('false'),
    SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN: z.string().optional(),
    MCP_ATLASSIAN_ENABLED: z.string().default('false'),
    ATLASSIAN_ORG_ID: z.string().optional(),
    ATLASSIAN_API_TOKEN: z.string().optional(),
    ATLASSIAN_EMAIL: z.string().optional(),
    // AI Provider configuration. PR-A removed 'openrouter'; PR-B B5 lights up
    // 'openai' at runtime — for now the AIService factory rejects it.
    AI_PROVIDER: z.enum(['openai', 'anthropic', 'mock']).default('mock'),
    // DOGFOOD_MODE: token-free + GitHub-free local exercise. When `true`,
    // PipelineOrchestrator.validateGitHubAccess returns a stub
    // `{ token: 'ghp_mock_dogfood', owner: 'dogfood-owner' }` and
    // GET /api/integrations/github/status returns `connected: true` without
    // touching the user's encrypted token. Strictly a dev/demo flag —
    // forbidden in production (see superRefine below). Default `false`.
    DOGFOOD_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AI_KEY_ENCRYPTION_KEY: z.string().optional(),
    AI_KEY_ENCRYPTION_KEY_VERSION: z.string().default('v1'),
    AI_DETERMINISTIC_MODE: z.enum(['true', 'false']).default('true'),
    AI_FORCE_DETERMINISTIC_PLAN: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    AI_SCRIBE_MODEL_ALLOWLIST: z.string().optional(),
    /**
     * Multiplier applied to wholesale AI provider cost when displaying retail
     * price to end users (non-admins). Default 1.5 = 50% margin.
     * Admin users see the raw wholesale cost (+ margin breakdown) regardless.
     * Issue #449.
     */
    AI_COST_MARKUP: z.coerce.number().positive().default(1.5),
    /**
     * P5a: maximum bytes (UTF-8) of prompt/response content persisted to the
     * `job_ai_calls` table per call. Anything over the limit is truncated with
     * a "... [truncated]" suffix so production DB does not balloon. Default
     * 100KB is enough for typical Scribe/Proto/Trace prompts; raise via env
     * for debugging huge calls.
     */
    AI_LOG_CONTENT_MAX_BYTES: z.coerce.number().int().positive().default(100_000),

    // API Keys (PR-A removed OPENROUTER_*; OPENAI_* kept as a legacy alias for now)
    AI_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),

    // Base URLs
    AI_BASE_URL: z.string().url().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),

    // Model names
    AI_MODEL: z.string().optional(),
    AI_MODEL_DEFAULT: z.string().optional(),
    AI_MODEL_PLANNER: z.string().optional(),
    AI_MODEL_VALIDATION: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),

    // GitHub private key (base64 encoded)
    GITHUB_PRIVATE_KEY_BASE64: z.string().optional(),

    // Piri RAG Engine (M2)
    PIRI_BASE_URL: z.preprocess(
      (val) => (val === '' || val === undefined ? undefined : val),
      z.string().url().optional()
    ),

    // Slack Integration (Smart Automations)
    SLACK_BOT_TOKEN: z.string().optional(), // xoxb-xxx Bot token
    SLACK_DEFAULT_CHANNEL: z.string().optional(), // C0123456789 or #channel-name

    // Reverse proxy
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // Feature flags
    // Control access to unstable/experimental features
    FEATURE_FLAG_UNSTABLE_ROUTES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // PDP-3 B4: when true, Proto pushes to GitHub immediately after generation
    // (legacy behaviour). When false (default), the pipeline halts at the new
    // `awaiting_push_confirm` stage so the user can inspect the scaffold via
    // the inline Sandpack preview and explicitly confirm before any GitHub
    // commit happens. Defaults to OFF so the bakkal-trust gate is the default
    // experience; CI / smoke tests can opt back in by setting it to true.
    AUTO_PUSH_AFTER_PROTO: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AGENT_CONTRACT_ENFORCEMENT_MODE: z.enum(['observe', 'enforce']).default('observe'),
    AGENT_CONTRACT_RETRY_POLICY: z.enum(['abort', 'retry_once']).default('abort'),
    RELIABILITY_CANARY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    RELIABILITY_CANARY_SALT: z.string().default('akis-reliability-v1'),
    AGENT_CONTRACT_CANARY_PERCENT: z.coerce.number().int().min(0).max(100).default(100),
    VERIFICATION_GATE_ROLLOUT_MODE: z
      .enum(['observe', 'warn', 'enforce_scribe', 'enforce_all'])
      .default('observe'),
    VERIFICATION_GATE_CANARY_PERCENT: z.coerce.number().int().min(0).max(100).default(100),
    FRESHNESS_SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    FRESHNESS_SCHEDULER_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(360),
    FRESHNESS_THRESHOLD_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    FRESHNESS_AGING_THRESHOLD_DAYS: z.coerce.number().int().min(1).max(3650).default(45),
    MCP_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
    MCP_GATEWAY_RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(2),

    /**
     * Issue #462 — wires chat-level conversation memory into pipeline
     * agent calls (Scribe/Proto/Trace). When enabled, each agent call
     * assembles the prior chat turns + dedup'd RAG hits into a bounded
     * "Conversation so far" block that is appended to the cacheable
     * system prompt prefix. Default `false` → zero behaviour change, so
     * flag rollout is staging-first → canary → prod flip.
     */
    CHAT_CONTEXT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /** Maximum tokens reserved for the chat-memory block (default 8K per issue #462 acceptance). */
    CHAT_CONTEXT_MAX_TOKENS: z.coerce.number().int().min(256).max(32_000).default(8_000),

    /**
     * P8 — minimum CriticAgent overallScore (0-100) required for the code/spec
     * review to count as "approved". When the score is below this threshold the
     * orchestrator halts at `awaiting_critic_resolution` so the user can either
     * iterate on the feedback or manually override the block. Default 75 mirrors
     * the legacy hard-coded constant.
     */
    CRITIC_APPROVAL_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  })
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';
    const isTestMode = data.NODE_ENV === 'test' || process.env.CI === 'true';
    const isAtlassianEnabled = data.MCP_ATLASSIAN_ENABLED === 'true';
    // Atlassian credentials are only required when explicitly enabled, not just because we're in production
    // This allows staging/prod deployments without Atlassian integration
    const isAtlassianStrictMode = isAtlassianEnabled;

    // AUTH_JWT_SECRET is required except in test/CI mode
    if (!isTestMode && !data.AUTH_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_JWT_SECRET is required and must be at least 32 characters long',
        path: ['AUTH_JWT_SECRET'],
      });
    }

    if (data.AUTH_COOKIE_MAXAGE <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_COOKIE_MAXAGE must be greater than 0 seconds',
        path: ['AUTH_COOKIE_MAXAGE'],
      });
    }

    if (data.FRESHNESS_AGING_THRESHOLD_DAYS > data.FRESHNESS_THRESHOLD_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FRESHNESS_AGING_THRESHOLD_DAYS cannot be greater than FRESHNESS_THRESHOLD_DAYS',
        path: ['FRESHNESS_AGING_THRESHOLD_DAYS'],
      });
    }

    if (isProduction && !data.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_COOKIE_SECURE must be true when NODE_ENV=production',
        path: ['AUTH_COOKIE_SECURE'],
      });
    }

    // DOGFOOD_MODE stubs out GitHub auth + status — never legal in production.
    if (isProduction && data.DOGFOOD_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'DOGFOOD_MODE=true is forbidden when NODE_ENV=production — it disables GitHub token validation and returns a fake "connected" status to every authenticated user',
        path: ['DOGFOOD_MODE'],
      });
    }

    // AI_KEY_ENCRYPTION_KEY is strongly recommended but not strictly required
    // This allows staging deployments without user AI key encryption feature
    // A warning will be logged at startup if not configured
    if (!isTestMode && !data.AI_KEY_ENCRYPTION_KEY && isProduction) {
      logger.warn(
        '[env] WARNING: AI_KEY_ENCRYPTION_KEY is not set. User AI key encryption will be disabled.'
      );
    }

    // Email provider validation
    if (data.EMAIL_PROVIDER === 'resend') {
      if (!data.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
          path: ['RESEND_API_KEY'],
        });
      }
      if (!data.RESEND_FROM_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'RESEND_FROM_EMAIL is required when EMAIL_PROVIDER=resend',
          path: ['RESEND_FROM_EMAIL'],
        });
      }
    }

    if (data.EMAIL_PROVIDER === 'smtp') {
      if (!data.SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SMTP_HOST is required when EMAIL_PROVIDER=smtp',
          path: ['SMTP_HOST'],
        });
      }
      if (!data.SMTP_USER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SMTP_USER is required when EMAIL_PROVIDER=smtp',
          path: ['SMTP_USER'],
        });
      }
      if (!data.SMTP_PASS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SMTP_PASS is required when EMAIL_PROVIDER=smtp',
          path: ['SMTP_PASS'],
        });
      }
      if (!data.SMTP_FROM_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SMTP_FROM_EMAIL is required when EMAIL_PROVIDER=smtp',
          path: ['SMTP_FROM_EMAIL'],
        });
      }
    }

    // OAuth credentials validation
    // In production the login UI shows GitHub + Google buttons, so a missing
    // provider surfaces as a silent 503 OAUTH_NOT_CONFIGURED. We emit a loud
    // warning at startup (for `docker logs` triage) but do NOT fail fast —
    // the deploy-prod.yml smoke-test curls both endpoints and fails the
    // deploy on 503, which is the right layer to gate on actual HTTP
    // behavior rather than crashing the container at boot.
    if (isProduction) {
      if (!data.GITHUB_OAUTH_CLIENT_ID || !data.GITHUB_OAUTH_CLIENT_SECRET) {
        logger.warn(
          '[env] WARNING: GITHUB_OAUTH_CLIENT_ID/SECRET missing in production. ' +
            '/auth/oauth/github will return 503 OAUTH_NOT_CONFIGURED until set.'
        );
      }
      if (!data.GOOGLE_OAUTH_CLIENT_ID || !data.GOOGLE_OAUTH_CLIENT_SECRET) {
        logger.warn(
          '[env] WARNING: GOOGLE_OAUTH_CLIENT_ID/SECRET missing in production. ' +
            '/auth/oauth/google will return 503 OAUTH_NOT_CONFIGURED until set.'
        );
      }
    }

    // If a provider's client ID is provided, the secret must also be provided
    if (data.GITHUB_OAUTH_CLIENT_ID && !data.GITHUB_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GITHUB_OAUTH_CLIENT_SECRET is required when GITHUB_OAUTH_CLIENT_ID is provided',
        path: ['GITHUB_OAUTH_CLIENT_SECRET'],
      });
    }
    if (!data.GITHUB_OAUTH_CLIENT_ID && data.GITHUB_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GITHUB_OAUTH_CLIENT_ID is required when GITHUB_OAUTH_CLIENT_SECRET is provided',
        path: ['GITHUB_OAUTH_CLIENT_ID'],
      });
    }
    if (data.GOOGLE_OAUTH_CLIENT_ID && !data.GOOGLE_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_OAUTH_CLIENT_SECRET is required when GOOGLE_OAUTH_CLIENT_ID is provided',
        path: ['GOOGLE_OAUTH_CLIENT_SECRET'],
      });
    }
    if (!data.GOOGLE_OAUTH_CLIENT_ID && data.GOOGLE_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_OAUTH_CLIENT_ID is required when GOOGLE_OAUTH_CLIENT_SECRET is provided',
        path: ['GOOGLE_OAUTH_CLIENT_ID'],
      });
    }
    // Atlassian OAuth 2.0 (3LO) validation
    if (data.ATLASSIAN_OAUTH_CLIENT_ID && !data.ATLASSIAN_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'ATLASSIAN_OAUTH_CLIENT_SECRET is required when ATLASSIAN_OAUTH_CLIENT_ID is provided',
        path: ['ATLASSIAN_OAUTH_CLIENT_SECRET'],
      });
    }
    if (!data.ATLASSIAN_OAUTH_CLIENT_ID && data.ATLASSIAN_OAUTH_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'ATLASSIAN_OAUTH_CLIENT_ID is required when ATLASSIAN_OAUTH_CLIENT_SECRET is provided',
        path: ['ATLASSIAN_OAUTH_CLIENT_ID'],
      });
    }

    if (isAtlassianStrictMode) {
      // When Atlassian integration is explicitly enabled, require all Atlassian vars
      if (!data.ATLASSIAN_ORG_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ATLASSIAN_ORG_ID is required when MCP_ATLASSIAN_ENABLED=true',
          path: ['ATLASSIAN_ORG_ID'],
        });
      }

      if (!data.ATLASSIAN_API_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ATLASSIAN_API_TOKEN is required when MCP_ATLASSIAN_ENABLED=true',
          path: ['ATLASSIAN_API_TOKEN'],
        });
      }

      if (!data.ATLASSIAN_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ATLASSIAN_EMAIL is required when MCP_ATLASSIAN_ENABLED=true',
          path: ['ATLASSIAN_EMAIL'],
        });
      } else {
        // Validate email format when required
        const emailSchema = z.string().email();
        const emailResult = emailSchema.safeParse(data.ATLASSIAN_EMAIL);
        if (!emailResult.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'ATLASSIAN_EMAIL must be a valid email address',
            path: ['ATLASSIAN_EMAIL'],
          });
        }
      }
    }
    // In development with MCP_ATLASSIAN_ENABLED=false, all Atlassian vars are optional (no validation)
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Resolved AI configuration with fallbacks for legacy variable names
 */
export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'mock';
  apiKey: string | undefined;
  baseUrl: string;
  modelDefault: string;
  modelPlanner: string;
  modelValidation: string;
}

/**
 * Detect provider from model ID pattern.
 * OpenAI: starts with 'gpt-', 'o1', 'o3', 'text-', 'davinci'
 * Anthropic: starts with 'claude-'
 */
function detectProviderFromModel(model: string): 'openai' | 'anthropic' | null {
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('text-') ||
    model.startsWith('davinci')
  ) {
    return 'openai';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  return null;
}

/**
 * Detect provider from API key prefix.
 * Anthropic keys start with 'sk-ant-', OpenAI keys with 'sk-' (excluding 'sk-ant-').
 */
function detectProviderFromKey(key: string): 'openai' | 'anthropic' | null {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

/**
 * Get resolved AI configuration with strict provider consistency.
 *
 * CRITICAL: The provider value is AUTHORITATIVE. Base URL and models
 * are determined by provider, not by env overrides that might conflict.
 *
 * Provider value is authoritative — base URL and models come from provider,
 * not from env overrides that might point at a different host.
 *
 * Priority for provider detection:
 * 1. AI_PROVIDER env var (if set and not 'mock')
 * 2. Auto-detect from API key prefix
 * 3. Auto-detect from model names
 * 4. Default to 'mock'
 */
export function getAIConfig(env: Env): AIConfig {
  // Provider-specific defaults
  const OPENAI_DEFAULTS = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  };

  const ANTHROPIC_DEFAULTS = {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
  };

  // Step 1: Resolve API key (needed for provider detection)
  const apiKey = env.AI_API_KEY || env.OPENAI_API_KEY;

  // Step 2: Determine provider with validation
  let provider: 'openai' | 'anthropic' | 'mock' = env.AI_PROVIDER;

  // Auto-detect provider if set to mock but we have a real key
  if (provider === 'mock' && apiKey) {
    const keyProvider = detectProviderFromKey(apiKey);
    if (keyProvider) {
      provider = keyProvider;
      logger.info(`[getAIConfig] Auto-detected provider from API key: ${provider}`);
    }
  }

  // Warn if provider doesn't match API key pattern
  if (apiKey && provider !== 'mock') {
    const keyProvider = detectProviderFromKey(apiKey);
    if (keyProvider && keyProvider !== provider) {
      logger.warn(
        `[getAIConfig] WARNING: AI_PROVIDER=${provider} but API key looks like ${keyProvider} key. Using ${provider} anyway.`
      );
    }
  }

  // Step 3: Resolve base URL STRICTLY based on provider (ignore conflicting overrides)
  let baseUrl: string;
  if (provider === 'openai') {
    const envUrl = env.AI_BASE_URL || env.OPENAI_BASE_URL;
    baseUrl = envUrl ?? OPENAI_DEFAULTS.baseUrl;
  } else if (provider === 'anthropic') {
    const envUrl = env.AI_BASE_URL;
    baseUrl = envUrl && envUrl.includes('anthropic.com') ? envUrl : ANTHROPIC_DEFAULTS.baseUrl;
  } else {
    baseUrl = 'mock://localhost';
  }

  // Step 4: Resolve models with provider validation
  const getValidatedModel = (envModel: string | undefined, defaultModel: string): string => {
    if (!envModel) return defaultModel;

    const modelProvider = detectProviderFromModel(envModel);

    // If model clearly belongs to wrong provider, use default
    if (modelProvider && modelProvider !== provider) {
      logger.warn(
        `[getAIConfig] Model "${envModel}" is for ${modelProvider}, but provider is ${provider}. Using default: ${defaultModel}`
      );
      return defaultModel;
    }

    return envModel;
  };

  const providerDefault =
    provider === 'openai'
      ? OPENAI_DEFAULTS.model
      : provider === 'anthropic'
        ? ANTHROPIC_DEFAULTS.model
        : 'mock-model';

  const modelDefault = getValidatedModel(
    env.AI_MODEL_DEFAULT || env.AI_MODEL || env.OPENAI_MODEL,
    providerDefault
  );
  const modelPlanner = getValidatedModel(env.AI_MODEL_PLANNER, providerDefault);
  const modelValidation = getValidatedModel(env.AI_MODEL_VALIDATION, providerDefault);

  return {
    provider,
    apiKey,
    baseUrl,
    modelDefault,
    modelPlanner,
    modelValidation,
  };
}

let validatedEnv: Env | null = null;

/**
 * Test-only: clear the cached validated env so the next `getEnv()` call
 * re-reads `process.env`. Used by unit tests that flip feature flags
 * (e.g. `CHAT_CONTEXT_ENABLED`) mid-suite. Deliberately not exported
 * via the normal surface — only `test/` callers should invoke it.
 */
export function __clearEnvCacheForTests(): void {
  validatedEnv = null;
}

/**
 * Get validated environment variables
 * @throws Error if validation fails
 */
export function getEnv(): Env {
  if (validatedEnv) {
    return validatedEnv;
  }

  // Prepare env with test fallbacks for CI/test mode
  const isTestMode = process.env.NODE_ENV === 'test' || process.env.CI === 'true';
  const envWithFallbacks = {
    ...process.env,
    // Provide test fallback for AUTH_JWT_SECRET in CI/test mode
    AUTH_JWT_SECRET:
      process.env.AUTH_JWT_SECRET ||
      (isTestMode ? 'test-jwt-secret-at-least-32-chars-long' : undefined),
  };

  try {
    validatedEnv = envSchema.parse(envWithFallbacks);
    return validatedEnv;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missing = error.errors
        .filter((e) => e.code === 'invalid_type' && e.received === 'undefined')
        .map((e) => e.path.join('.'));
      const invalid = error.errors
        .filter((e) => e.code !== 'invalid_type' || e.received !== 'undefined')
        .map((e) => `${e.path.join('.')}: ${e.message}`);

      const messages: string[] = [];
      if (missing.length > 0) {
        messages.push(`Missing required env vars: ${missing.join(', ')}`);
      }
      if (invalid.length > 0) {
        messages.push(`Invalid env vars: ${invalid.join('; ')}`);
      }

      throw new Error(`Environment validation failed:\n${messages.join('\n')}`);
    }
    throw error;
  }
}
