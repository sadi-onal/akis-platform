/**
 * AIService - LLM-backed AI service for planning, generation, reflection, and validation
 *
 * Supports multiple providers (OpenRouter, OpenAI) with ENV-based configuration.
 * Uses different models for different tasks based on cost/capability trade-offs:
 * - Planner: AI_MODEL_PLANNER (can be same as default or specialized)
 * - Worker/Generation: AI_MODEL_DEFAULT (cheaper model for bulk tasks)
 * - Reflection: AI_MODEL_DEFAULT (critique and feedback)
 * - Validation: AI_MODEL_VALIDATION (stronger model for final verification)
 */

import { getEnv, getAIConfig, type AIConfig } from '../../config/env.js';
import { AIRateLimitedError, AIProviderError } from '../../core/errors.js';
import { logger } from '../../lib/logger.js';
import { z } from 'zod';

/**
 * Map user-facing model names to actual Anthropic API model IDs.
 * Pipeline/UI uses short names; the API needs dated model IDs.
 */
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
};

function resolveAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_MAP[model] ?? model;
}

/**
 * Anthropic prompt-caching minimum. Cached prefixes under ~1024 tokens
 * (~4 characters/token heuristic) do not amortise the 1.25x write multiplier,
 * so we skip cache_control for short prompts and send them as a plain string.
 * Configurable via `ANTHROPIC_CACHE_MIN_CHARS` for tests.
 */
function getCacheMinChars(): number {
  const raw = process.env.ANTHROPIC_CACHE_MIN_CHARS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // 1024 tokens * ~4 chars/token ≈ 4096. Round down to be safe.
  return 4096;
}

/**
 * `true` when prompt caching is enabled. Flag-gated so we can disable in an
 * emergency without redeploying. Default: on. Set `ANTHROPIC_PROMPT_CACHING=false`
 * to force the legacy plain-string system prompt.
 */
function isCachingEnabled(): boolean {
  return process.env.ANTHROPIC_PROMPT_CACHING !== 'false';
}

/**
 * Anthropic system-prompt block shape when using array form. The string form
 * is still valid — we upgrade to the array when the prompt is long enough to
 * benefit from caching.
 */
export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Build the `system` payload for Anthropic. Returns a plain string when the
 * prompt is too short to cache (avoids paying the 1.25x write multiplier);
 * otherwise returns a single-block array with `cache_control` attached so the
 * Anthropic API hashes + reuses the prefix.
 *
 * Exported so the multimodal + tool-calling paths can apply the same logic.
 */
export function buildCacheableSystemBlocks(systemText: string): string | AnthropicSystemBlock[] {
  if (!isCachingEnabled()) return systemText;
  if (!systemText || systemText.length < getCacheMinChars()) return systemText;
  return [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
}
import { estimateCostUsd } from './pricing.js';
import {
  DETERMINISTIC_TEMPERATURES,
  CREATIVE_TEMPERATURES,
  BALANCED_TEMPERATURES,
  DETERMINISTIC_SEED,
  PLAN_SYSTEM_PROMPT,
  buildPlanUserPrompt,
  GENERATE_SYSTEM_PROMPT,
  buildGenerateUserPrompt,
  REFLECT_SYSTEM_PROMPT,
  VALIDATE_SYSTEM_PROMPT,
  buildRepairPrompt,
} from './prompt-constants.js';

// =============================================================================
// JSON Schema Definitions for AI Responses
// =============================================================================

/**
 * Schema for Plan response from AI
 */
const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        detail: z.string().optional(),
      })
    )
    .min(1),
  rationale: z.string().optional(),
});

/**
 * Schema for Critique response from AI
 */
const CritiqueSchema = z.object({
  issues: z.array(z.string()),
  recommendations: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Schema for Validation response from AI
 */
const ValidationSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  summary: z.string(),
});

// =============================================================================
// Types and Interfaces
// =============================================================================

/**
 * Plan result structure - output of planning phase
 */
export interface Plan {
  steps: Array<{
    id: string;
    title: string;
    detail?: string;
  }>;
  rationale?: string;
}

/**
 * Critique result structure - output of reflection phase
 */
export interface Critique {
  issues: string[];
  recommendations: string[];
  severity?: 'low' | 'medium' | 'high';
}

/**
 * Validation result structure - output of strong-model validation
 */
export interface ValidationResult {
  passed: boolean;
  confidence: number; // 0-1 scale
  issues: string[];
  suggestions: string[];
  summary: string;
}

/**
 * Worker/Generation result structure
 */
export interface WorkerResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input types for various AI operations
 */
export interface PlanInput {
  agent: string;
  goal: string;
  context?: unknown;
}

export interface WorkerInput {
  task: string;
  context?: unknown;
  previousSteps?: string[];
  maxTokens?: number;
  systemPrompt?: string;
  modelOverride?: string;
}

export interface ReflectionInput {
  artifact: unknown;
  context?: unknown;
  checkResults?: {
    typecheck?: { passed: boolean; errors?: string[] };
    lint?: { passed: boolean; errors?: string[] };
    test?: { passed: boolean; errors?: string[] };
    build?: { passed: boolean; errors?: string[] };
  };
}

export interface ValidationInput {
  plan?: Plan;
  artifact: unknown;
  reflection?: Critique;
  checkResults?: ReflectionInput['checkResults'];
}

/**
 * Planner interface - generates execution plans
 * (Kept for backward compatibility with existing orchestrator)
 */
export interface Planner {
  plan(input: PlanInput): Promise<Plan>;
}

/**
 * Reflector interface - critiques execution artifacts
 * (Kept for backward compatibility with existing orchestrator)
 */
export interface Reflector {
  critique(input: {
    artifact: unknown;
    context?: unknown;
    checkResults?: ReflectionInput['checkResults'];
  }): Promise<Critique>;
}

/**
 * Full AIService interface with all capabilities
 */
export interface AIService {
  /** Legacy interfaces for backward compatibility */
  planner: Planner;
  reflector: Reflector;

  /** New structured methods */
  planTask(input: PlanInput): Promise<Plan>;
  generateWorkArtifact(input: WorkerInput): Promise<WorkerResult>;
  /** Multimodal variant — throws IMAGE_MODEL_UNSUPPORTED when provider lacks vision (issue #402 step 3). */
  generateMultimodalArtifact?(input: {
    systemPrompt: string;
    task: string;
    images: readonly import('./multimodalClient.js').AnthropicImageBlock[];
    maxTokens?: number;
    modelOverride?: string;
  }): Promise<WorkerResult>;
  reflectOnArtifact(input: ReflectionInput): Promise<Critique>;
  validateWithStrongModel(input: ValidationInput): Promise<ValidationResult>;

  /** Get current configuration (for debugging/logging, never expose secrets) */
  getConfigSummary(): {
    provider: string;
    models: { default: string; planner: string; validation: string };
    baseUrl: string;
    hasApiKey: boolean;
  };
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Anthropic prompt caching (issue #436).
   * `cacheCreationInputTokens` = tokens written into the cache this call (~1.25× input pricing).
   * `cacheReadInputTokens`    = tokens served from the cache this call    (~0.10× input pricing).
   * Both are zero / absent for non-Anthropic providers and for the first
   * call of a new prefix. Present only when the provider returned them.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface AICallMetrics {
  purpose: string;
  provider: string;
  model: string;
  durationMs?: number;
  usage?: AIUsage;
  estimatedCostUsd?: number | null;
  success: boolean;
  errorCode?: string;
  /**
   * P5a: optional payload content captured for persistence to `job_ai_calls`
   * (consumed by the upcoming admin/debug viewer, P5b). Truncation happens
   * at the persistence layer (TraceRecorder), not here — observers that
   * don't care about content can ignore these fields. Older callers that
   * only emit metrics keep working unchanged.
   */
  content?: {
    systemPrompt?: string;
    userPrompt?: string;
    responseText?: string;
    thinkingBlocks?: unknown;
    toolCalls?: unknown;
  };
}

export interface AIServiceObserver {
  onAiCall: (metrics: AICallMetrics) => void;
}

type RuntimeProfile = 'deterministic' | 'balanced' | 'creative' | 'custom';

type TemperatureSet = {
  plan: number;
  generate: number;
  reflect: number;
  validate: number;
  repair: number;
};

export interface AIServiceRuntimeOptions {
  runtimeProfile?: RuntimeProfile;
  temperatureValue?: number | null;
}

// =============================================================================
// OpenRouter/OpenAI Compatible Implementation
// =============================================================================

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Real AI Service implementation using OpenRouter/OpenAI compatible APIs
 */
class RealAIService implements AIService {
  private config: AIConfig;
  public planner: Planner;
  public reflector: Reflector;
  private observer?: AIServiceObserver;
  private runtimeOptions: AIServiceRuntimeOptions;

  // Retry configuration - can be overridden via environment
  private readonly maxRetries: number;
  private readonly baseRetryDelay: number;

  /**
   * Whether the AI service operates in deterministic mode (S0.5.1-AGT-2).
   * Deterministic mode: lower temperatures + seed for reproducible output.
   * Defaults to true (pilot-safe). Set AI_DETERMINISTIC_MODE=false to disable.
   */
  private getDeterministicMode(): boolean {
    return process.env.AI_DETERMINISTIC_MODE !== 'false';
  }

  /**
   * Force deterministic planning regardless of runtime profile.
   * Enabled by default for reproducible plan generation.
   */
  private shouldForceDeterministicPlan(): boolean {
    return process.env.AI_FORCE_DETERMINISTIC_PLAN !== 'false';
  }

  constructor(
    config: AIConfig,
    observer?: AIServiceObserver,
    runtimeOptions: AIServiceRuntimeOptions = {}
  ) {
    this.config = config;
    this.observer = observer;
    this.runtimeOptions = runtimeOptions;

    // Configure retry behavior from environment or use defaults
    this.maxRetries = parseInt(process.env.AI_PLANNER_MAX_RETRIES || '3', 10);
    this.baseRetryDelay = parseInt(process.env.AI_RETRY_BASE_DELAY_MS || '1000', 10);

    // Create legacy interfaces that delegate to new methods
    this.planner = {
      plan: (input: PlanInput) => this.planTask(input),
    };

    this.reflector = {
      critique: (input: {
        artifact: unknown;
        context?: unknown;
        checkResults?: ReflectionInput['checkResults'];
      }) =>
        this.reflectOnArtifact({
          artifact: input.artifact,
          context: input.context,
          checkResults: input.checkResults,
        }),
    };
  }

  private getTemperatures(): TemperatureSet {
    const profile = this.runtimeOptions.runtimeProfile;
    if (profile === 'balanced') {
      return BALANCED_TEMPERATURES;
    }
    if (profile === 'creative') {
      return CREATIVE_TEMPERATURES;
    }
    if (profile === 'custom') {
      const raw = this.runtimeOptions.temperatureValue;
      const base =
        typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(1, Math.max(0, raw))
          : DETERMINISTIC_TEMPERATURES.generate;
      return {
        plan: Math.min(1, Math.max(0, base * 0.85)),
        generate: base,
        reflect: Math.min(1, Math.max(0, base * 0.65)),
        validate: Math.min(0.3, Math.max(0, base * 0.5)),
        repair: 0,
      };
    }
    return this.getDeterministicMode() ? DETERMINISTIC_TEMPERATURES : CREATIVE_TEMPERATURES;
  }

  getConfigSummary() {
    return {
      provider: this.config.provider,
      models: {
        default: this.config.modelDefault,
        planner: this.config.modelPlanner,
        validation: this.config.modelValidation,
      },
      baseUrl: this.config.baseUrl,
      hasApiKey: Boolean(this.config.apiKey),
    };
  }

  /**
   * Delay helper for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse retry-after header from response
   */
  private parseRetryAfter(response: Response): number | undefined {
    const retryAfter = response.headers.get('retry-after');
    if (!retryAfter) return undefined;

    // Could be seconds (integer) or HTTP-date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000; // Convert to ms

    // Try parsing as date
    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
      const delayMs = date - Date.now();
      return delayMs > 0 ? delayMs : undefined;
    }

    return undefined;
  }

  /**
   * Build request for Anthropic Messages API.
   *
   * Prompt caching (issue #436): the concatenated system prompt is sent as an
   * array block with `cache_control: { type: 'ephemeral' }` so Anthropic hashes
   * the prefix once and reuses it across subsequent calls (5-min TTL). System
   * prompts are stable across pipeline iterations, so marking them yields ~90%
   * cost reduction + ~2x latency improvement on repeat calls.
   *
   * User turn content is NEVER marked — it changes every turn and should not
   * dirty the cache key. Only the static prefix (system + any large stable
   * context block) is cacheable.
   *
   * Cache tokens under ANTHROPIC_CACHE_MIN_TOKENS (default 1024) are not worth
   * the 1.25x write multiplier; callers can still opt in via options, but the
   * default only marks system prompts that cross the break-even threshold.
   */
  private buildAnthropicRequest(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number }
  ): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const endpoint = `${this.config.baseUrl}/v1/messages`;

    // Separate system message from user/assistant messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey!,
      'anthropic-version': '2023-06-01',
    };

    const resolvedModel = resolveAnthropicModel(model);

    const body: Record<string, unknown> = {
      model: resolvedModel,
      max_tokens: options.maxTokens ?? 4096,
      messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    };

    if (systemMessages.length > 0) {
      const systemText = systemMessages.map((m) => m.content).join('\n\n');
      body.system = buildCacheableSystemBlocks(systemText);
    }

    return { endpoint, headers, body };
  }

  /**
   * Build request for Google Gemini's `generateContent` REST endpoint (P1c).
   *
   * Gemini's API shape is unique among the three providers:
   *   - Auth via `?key=<API_KEY>` query string, NOT a header.
   *   - Per-model endpoint path: `/v1beta/models/{model}:generateContent`.
   *   - `system` is a top-level `systemInstruction` block, NOT a role-in-array.
   *   - Roles in `contents[]` use `user` + `model` (assistant → model).
   *   - Generation tuning lives in `generationConfig: { temperature, maxOutputTokens }`.
   *
   * Multimodal (image parts) is out of scope for this PR — text-only.
   */
  private buildGoogleRequest(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number }
  ): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const apiKey = this.config.apiKey!;
    const endpoint =
      `${this.config.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };

    // Separate system prompts (Gemini puts them in `systemInstruction`, not contents[]).
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const contents = nonSystemMessages.map((m) => ({
      // Anthropic/OpenAI use `assistant`; Gemini uses `model`.
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        maxOutputTokens: options.maxTokens ?? 4096,
      },
    };

    if (systemMessages.length > 0) {
      const systemText = systemMessages.map((m) => m.content).join('\n\n');
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    return { endpoint, headers, body };
  }

  /**
   * Build request for OpenAI-compatible APIs (OpenAI, OpenRouter)
   */
  private buildOpenAIRequest(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number; seed?: number | null }
  ): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const endpoint = `${this.config.baseUrl}/chat/completions`;
    const resolvedSeed = options.seed === null ? undefined : (options.seed ?? DETERMINISTIC_SEED);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    // (OpenRouter-specific HTTP-Referer/X-Title headers were removed in PR-A
    // along with the rest of the OpenRouter integration.)

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
      ...(resolvedSeed !== undefined && { seed: resolvedSeed }),
    };

    return { endpoint, headers, body };
  }

  /**
   * Parse Anthropic Messages API response into standard format.
   *
   * Also extracts `cache_creation_input_tokens` + `cache_read_input_tokens`
   * (issue #436) from the `usage` field. These are surfaced on `AIUsage` so
   * the collector can accumulate them and the billing layer can price the
   * cache read (at ~0.10x) separately from a fresh input (at 1.00x).
   */
  private parseAnthropicResponse(data: Record<string, unknown>): {
    content: string;
    usage?: AIUsage;
    thinkingBlocks?: unknown[];
    toolCalls?: unknown[];
  } {
    const contentArray = (data.content ?? []) as Array<Record<string, unknown>>;
    const textBlocks = contentArray.filter((b) => b.type === 'text') as Array<{ text: string }>;
    const content = textBlocks.map((b) => b.text).join('');

    // P5a: surface extended-thinking + tool_use blocks for AI call logging.
    // We only forward the blocks themselves; the persistence layer decides
    // whether to keep, truncate, or drop them.
    const thinkingBlocks = contentArray.filter(
      (b) => b.type === 'thinking' || b.type === 'redacted_thinking'
    );
    const toolCalls = contentArray.filter((b) => b.type === 'tool_use');

    const rawUsage = data.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    const usage: AIUsage | undefined = rawUsage
      ? {
          inputTokens: rawUsage.input_tokens,
          outputTokens: rawUsage.output_tokens,
          totalTokens: (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
          ...(typeof rawUsage.cache_creation_input_tokens === 'number' && {
            cacheCreationInputTokens: rawUsage.cache_creation_input_tokens,
          }),
          ...(typeof rawUsage.cache_read_input_tokens === 'number' && {
            cacheReadInputTokens: rawUsage.cache_read_input_tokens,
          }),
        }
      : undefined;

    return {
      content,
      usage,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Parse Google Gemini `generateContent` response into the standard format (P1c).
   *
   * Gemini returns: `{ candidates: [{ content: { parts: [{ text }] }, finishReason }],
   * usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount } }`.
   * We pick the first candidate, concatenate its text parts, and map the
   * usageMetadata fields onto AIUsage (input = prompt, output = candidates).
   *
   * Cache token fields are intentionally omitted — Gemini exposes implicit cache
   * stats only in v1beta paid tier and the format isn't stable yet; we'll
   * revisit in a follow-up once that lands.
   */
  private parseGoogleResponse(data: Record<string, unknown>): {
    content: string;
    usage?: AIUsage;
  } {
    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
    if (candidates.length === 0) {
      throw new AIProviderError(
        'AI_INVALID_RESPONSE',
        'Gemini API returned no candidates',
        this.config.provider
      );
    }

    const firstCandidate = candidates[0];
    const candidateContent = firstCandidate.content as
      | { parts?: Array<{ text?: string }> }
      | undefined;
    const parts = candidateContent?.parts ?? [];
    const content = parts.map((p) => p.text ?? '').join('');

    const rawUsage = data.usageMetadata as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined;
    const usage: AIUsage | undefined = rawUsage
      ? {
          inputTokens: rawUsage.promptTokenCount,
          outputTokens: rawUsage.candidatesTokenCount,
          totalTokens:
            rawUsage.totalTokenCount ??
            (rawUsage.promptTokenCount ?? 0) + (rawUsage.candidatesTokenCount ?? 0),
        }
      : undefined;

    return { content, usage };
  }

  /**
   * Parse OpenAI-compatible response into standard format
   */
  private parseOpenAIResponse(data: ChatCompletionResponse): {
    content: string;
    usage?: AIUsage;
    toolCalls?: unknown[];
  } {
    if (!data.choices || data.choices.length === 0) {
      throw new AIProviderError(
        'AI_INVALID_RESPONSE',
        'AI API returned no choices',
        this.config.provider
      );
    }

    const usage: AIUsage | undefined = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined;

    // P5a: OpenAI exposes tool calls via `choices[0].message.tool_calls`.
    // Thinking blocks are Anthropic-specific so OpenAI returns none.
    const message = data.choices[0].message as { content: string; tool_calls?: unknown[] };
    const toolCalls =
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : undefined;

    return { content: message.content, usage, toolCalls };
  }

  /**
   * Human-friendly label for the current provider (used in error messages
   * surfaced to the chat UI). Defaults to capitalised provider name for any
   * future addition so the chain doesn't silently mis-label.
   */
  private getProviderLabel(): string {
    switch (this.config.provider) {
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      case 'google':
        return 'Google Gemini';
      default:
        return this.config.provider;
    }
  }

  /**
   * Make a chat completion request to the AI API with retry logic
   */
  private async chatCompletion(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number; seed?: number | null } = {},
    purpose: string = 'unknown'
  ): Promise<{ content: string; usage?: AIUsage; durationMs?: number }> {
    if (!this.config.apiKey) {
      throw new AIProviderError(
        'AI_AUTH_ERROR',
        `AI API key not configured for provider: ${this.config.provider}`,
        this.config.provider
      );
    }

    // Build provider-specific request
    const isAnthropic = this.config.provider === 'anthropic';
    const isGoogle = this.config.provider === 'google';
    const { endpoint, headers, body } = isAnthropic
      ? this.buildAnthropicRequest(messages, model, options)
      : isGoogle
        ? this.buildGoogleRequest(messages, model, options)
        : this.buildOpenAIRequest(messages, model, options);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const durationMs = Date.now() - startTime;

        // Handle rate limiting (429)
        if (response.status === 429) {
          const retryAfterMs =
            this.parseRetryAfter(response) || this.baseRetryDelay * Math.pow(2, attempt);
          const errorText = await response.text().catch(() => 'Rate limited');

          logger.warn(
            `[AIService] Rate limited by ${this.config.provider} (attempt ${attempt + 1}/${this.maxRetries + 1}), ` +
              `retrying in ${retryAfterMs}ms: ${errorText.substring(0, 200)}`
          );

          // If this is the last attempt, throw the error
          if (attempt >= this.maxRetries) {
            const rateError = new AIRateLimitedError(
              this.config.provider,
              Math.ceil(retryAfterMs / 1000),
              errorText.substring(0, 500)
            );
            this.observer?.onAiCall({
              purpose,
              provider: this.config.provider,
              model,
              durationMs,
              success: false,
              errorCode: rateError.code,
            });
            throw rateError;
          }

          // Wait and retry
          await this.delay(Math.min(retryAfterMs, 30000)); // Cap at 30s
          continue;
        }

        // Handle other errors
        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');

          // Auth errors (401, 403) - provide clear, actionable message.
          // Gemini returns 400 with code PERMISSION_DENIED when the key is bad,
          // but it also returns 401/403 for legitimate auth issues — mapping all
          // auth-class statuses here keeps the user-facing message consistent.
          if (response.status === 401 || response.status === 403) {
            const providerLabel = this.getProviderLabel();

            // Create user-friendly error message (don't expose raw API errors like "cookie auth")
            let friendlyMessage: string;
            if (response.status === 401) {
              friendlyMessage = `${providerLabel} API key is invalid or expired. Please check your API key in Settings > AI Keys.`;
            } else {
              friendlyMessage = `${providerLabel} API access denied. Your API key may lack required permissions.`;
            }

            // Log raw error for debugging but don't expose to user
            logger.error(
              `[AIService] Auth error from ${this.config.provider}: ${errorText.substring(0, 300)}`
            );

            const authError = new AIProviderError(
              'AI_AUTH_ERROR',
              friendlyMessage,
              this.config.provider,
              response.status
            );
            this.observer?.onAiCall({
              purpose,
              provider: this.config.provider,
              model,
              durationMs,
              success: false,
              errorCode: authError.code,
            });
            throw authError;
          }

          // Model not found errors (404) - provide actionable message
          if (response.status === 404) {
            const providerLabel = this.getProviderLabel();
            const modelNotFoundError = new AIProviderError(
              'AI_MODEL_NOT_FOUND',
              `Model "${model}" is not available on ${providerLabel}. Please select a different model in the agent configuration.`,
              this.config.provider,
              response.status
            );
            logger.error(
              `[AIService] Model not found on ${this.config.provider}: ${model}. Raw error: ${errorText.substring(0, 200)}`
            );
            this.observer?.onAiCall({
              purpose,
              provider: this.config.provider,
              model,
              durationMs,
              success: false,
              errorCode: modelNotFoundError.code,
            });
            throw modelNotFoundError;
          }

          // Server errors (5xx) - retry
          if (response.status >= 500 && attempt < this.maxRetries) {
            logger.warn(
              `[AIService] Server error from ${this.config.provider} (${response.status}), ` +
                `retrying in ${this.baseRetryDelay * Math.pow(2, attempt)}ms`
            );
            await this.delay(this.baseRetryDelay * Math.pow(2, attempt));
            continue;
          }

          // Generic error - provide friendly message
          const providerLabel = this.getProviderLabel();
          let friendlyMessage = `${providerLabel} returned an error (${response.status}).`;

          // Add context based on error content
          if (
            errorText.toLowerCase().includes('credit') ||
            errorText.toLowerCase().includes('billing') ||
            errorText.toLowerCase().includes('balance')
          ) {
            friendlyMessage = `${providerLabel} account has insufficient credits. Please add credits or update your API key.`;
          } else if (
            errorText.toLowerCase().includes('rate') ||
            errorText.toLowerCase().includes('limit')
          ) {
            friendlyMessage = `${providerLabel} rate limit exceeded. Please try again in a few moments.`;
          } else if (
            errorText.toLowerCase().includes('model') ||
            errorText.toLowerCase().includes('route')
          ) {
            friendlyMessage = `Model "${model}" may not be available on ${providerLabel}. Please try a different model.`;
          }

          logger.error(
            `[AIService] Provider error from ${this.config.provider}: ${errorText.substring(0, 300)}`
          );

          const providerError = new AIProviderError(
            'AI_PROVIDER_ERROR',
            friendlyMessage,
            this.config.provider,
            response.status
          );
          this.observer?.onAiCall({
            purpose,
            provider: this.config.provider,
            model,
            durationMs,
            success: false,
            errorCode: providerError.code,
          });
          throw providerError;
        }

        const data = await response.json();

        // Parse response based on provider format
        const parsed = isAnthropic
          ? this.parseAnthropicResponse(data as Record<string, unknown>)
          : isGoogle
            ? this.parseGoogleResponse(data as Record<string, unknown>)
            : this.parseOpenAIResponse(data as ChatCompletionResponse);

        const estimatedCostUsd = parsed.usage
          ? estimateCostUsd(
              model,
              parsed.usage.inputTokens,
              parsed.usage.outputTokens,
              parsed.usage.cacheCreationInputTokens,
              parsed.usage.cacheReadInputTokens
            )
          : null;

        // P5a: forward prompt/response content to the observer so it can be
        // persisted to `job_ai_calls`. We pull system + user from the
        // `messages` argument (which is the same array we just sent to the
        // provider) so we capture exactly what went over the wire.
        const systemPrompt = messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n');
        const userPrompt = messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n\n');
        const anthropicThinking = 'thinkingBlocks' in parsed ? parsed.thinkingBlocks : undefined;
        const parsedToolCalls = 'toolCalls' in parsed ? parsed.toolCalls : undefined;

        this.observer?.onAiCall({
          purpose,
          provider: this.config.provider,
          model,
          durationMs,
          usage: parsed.usage,
          estimatedCostUsd,
          success: true,
          content: {
            systemPrompt: systemPrompt || undefined,
            userPrompt: userPrompt || undefined,
            responseText: parsed.content,
            thinkingBlocks: anthropicThinking,
            toolCalls: parsedToolCalls,
          },
        });

        return {
          content: parsed.content,
          usage: parsed.usage,
          durationMs,
        };
      } catch (error) {
        // If it's already our custom error, rethrow
        if (error instanceof AIProviderError) {
          throw error;
        }

        // Network errors - retry
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.maxRetries) {
          logger.warn(
            `[AIService] Network error (attempt ${attempt + 1}/${this.maxRetries + 1}): ${lastError.message}`
          );
          await this.delay(this.baseRetryDelay * Math.pow(2, attempt));
          continue;
        }
      }
    }

    // All retries exhausted
    const networkError = new AIProviderError(
      'AI_NETWORK_ERROR',
      `AI chat completion failed after ${this.maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`,
      this.config.provider
    );
    this.observer?.onAiCall({
      purpose,
      provider: this.config.provider,
      model,
      success: false,
      errorCode: networkError.code,
    });
    throw networkError;
  }

  /**
   * Extract JSON from AI response, handling markdown code blocks and extra text
   */
  private extractJsonString(response: string): string {
    // Try to extract JSON from markdown code blocks first
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find JSON object/array in the response
    const jsonObjectMatch = response.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = response.match(/\[[\s\S]*\]/);

    if (jsonObjectMatch) {
      return jsonObjectMatch[0];
    }
    if (jsonArrayMatch) {
      return jsonArrayMatch[0];
    }

    return response.trim();
  }

  /**
   * Parse and validate JSON from AI response with schema validation
   * @param response Raw AI response string
   * @param schema Zod schema for validation
   * @param context Description of what we're parsing (for logging)
   * @returns Parsed and validated response
   * @throws AIProviderError if parsing/validation fails after repair attempt
   */
  private async parseWithSchema<T>(
    response: string,
    schema: z.ZodSchema<T>,
    context: string
  ): Promise<T> {
    const jsonStr = this.extractJsonString(response);

    // First attempt: parse and validate
    try {
      const parsed = JSON.parse(jsonStr);
      const validated = schema.parse(parsed);
      return validated;
    } catch (firstError) {
      logger.warn(
        `[AIService] First parse attempt failed for ${context}: ${firstError instanceof Error ? firstError.message : 'unknown'}`
      );

      // Log raw response (redacted) for debugging
      const redactedResponse =
        response.length > 500 ? response.substring(0, 500) + '...(truncated)' : response;
      logger.warn(`[AIService] Raw response (redacted): ${redactedResponse}`);

      // Repair attempt: ask AI to fix the JSON
      try {
        const repairPromptText = buildRepairPrompt(JSON.stringify(schema._def), response);

        const repairedResponse = await this.chatCompletion(
          [{ role: 'user', content: repairPromptText }],
          this.config.modelDefault,
          { temperature: DETERMINISTIC_TEMPERATURES.repair, maxTokens: 2048 },
          `repair:${context}`
        );

        const repairedJsonStr = this.extractJsonString(repairedResponse.content);
        const reparsed = JSON.parse(repairedJsonStr);
        const revalidated = schema.parse(reparsed);

        logger.info(`[AIService] Successfully repaired JSON for ${context}`);
        return revalidated;
      } catch (repairError) {
        // Both attempts failed - throw with details
        const errorMessage = repairError instanceof Error ? repairError.message : 'unknown';
        logger.error(`[AIService] JSON repair failed for ${context}: ${errorMessage}`);
        logger.error(`[AIService] Model: ${this.config.modelDefault}`);

        throw new AIProviderError(
          'AI_INVALID_RESPONSE',
          `Failed to parse AI response for ${context} after repair attempt. ` +
            `Error: ${errorMessage}. ` +
            `Raw response saved in logs.`,
          this.config.provider
        );
      }
    }
  }

  /**
   * Plan a task - uses AI_MODEL_PLANNER with strict JSON schema validation
   */
  async planTask(input: PlanInput): Promise<Plan> {
    const temps = this.getTemperatures();
    const forceDeterministicPlan = this.shouldForceDeterministicPlan();
    const userPrompt = buildPlanUserPrompt(input.agent, input.goal, input.context);

    const response = await this.chatCompletion(
      [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      this.config.modelPlanner,
      {
        temperature: forceDeterministicPlan ? DETERMINISTIC_TEMPERATURES.plan : temps.plan,
        seed: forceDeterministicPlan ? DETERMINISTIC_SEED : null,
      },
      'plan'
    );

    return this.parseWithSchema(response.content, PlanSchema, 'planTask');
  }

  /**
   * Generate work artifact - uses AI_MODEL_DEFAULT
   */
  async generateWorkArtifact(input: WorkerInput): Promise<WorkerResult> {
    const temps = this.getTemperatures();
    const systemPrompt = input.systemPrompt ?? GENERATE_SYSTEM_PROMPT;
    const userPrompt = buildGenerateUserPrompt(input.task, input.context, input.previousSteps);
    const model = input.modelOverride || this.config.modelDefault;

    const response = await this.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      model,
      { temperature: temps.generate, maxTokens: input.maxTokens ?? 4096 },
      'generate'
    );

    // Surface the per-call USD cost on `metadata.estimatedCostUsd` so the
    // pipeline factory's TokenUsageCallback can accumulate it and the
    // orchestrator can write `pipelines.metrics.estimatedCost` — which is
    // what the Settings → Usage SQL aggregates (PR-V settings/usage fix).
    const estimatedCostUsd = response.usage
      ? estimateCostUsd(
          model,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cacheCreationInputTokens,
          response.usage.cacheReadInputTokens
        )
      : null;

    return {
      content: response.content,
      metadata: {
        model,
        task: input.task,
        provider: this.config.provider,
        usage: response.usage,
        durationMs: response.durationMs,
        estimatedCostUsd,
      },
    };
  }

  /**
   * Multimodal variant of {@link generateWorkArtifact} — sends user images +
   * text to Anthropic's Messages API. Only Anthropic supports vision in the
   * AKIS provider set; other providers throw `IMAGE_MODEL_UNSUPPORTED` so
   * callers fall back to the text-only path.
   *
   * Issue #402 step 3. Wraps the standalone {@link callAnthropicMultimodal}
   * helper shipped in #416 and plugs it into AIServiceLike so the pipeline
   * factory can detect capability and wire ScribeAIDeps.generateTextWithImages.
   */
  async generateMultimodalArtifact(input: {
    systemPrompt: string;
    task: string;
    images: readonly import('./multimodalClient.js').AnthropicImageBlock[];
    maxTokens?: number;
    modelOverride?: string;
  }): Promise<WorkerResult> {
    if (this.config.provider !== 'anthropic') {
      throw new (await import('./multimodalClient.js')).AnthropicMultimodalError(
        `Provider "${this.config.provider}" does not support image input`,
        'IMAGE_MODEL_UNSUPPORTED'
      );
    }
    if (!this.config.apiKey) {
      throw new (await import('./multimodalClient.js')).AnthropicMultimodalError(
        'Anthropic API key is not configured',
        'IMAGE_API_ERROR'
      );
    }

    const { callAnthropicMultimodal } = await import('./multimodalClient.js');
    const temps = this.getTemperatures();
    const model = input.modelOverride || this.config.modelDefault;
    const resolvedModel = resolveAnthropicModel(model);
    const start = Date.now();

    const result = await callAnthropicMultimodal({
      apiKey: this.config.apiKey,
      model: resolvedModel,
      systemPrompt: input.systemPrompt,
      userText: input.task,
      images: input.images,
      maxTokens: input.maxTokens ?? 4096,
      temperature: temps.generate,
      baseUrl: this.config.baseUrl,
    });

    const durationMs = Date.now() - start;
    // Same per-call cost surface as text-only generateWorkArtifact, so
    // multimodal stages also contribute to pipelines.metrics.estimatedCost.
    const estimatedCostUsd = result.usage
      ? estimateCostUsd(
          resolvedModel,
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.cacheCreationInputTokens,
          result.usage.cacheReadInputTokens
        )
      : null;
    return {
      content: result.content,
      metadata: {
        model,
        task: input.task,
        provider: 'anthropic',
        usage: result.usage,
        durationMs,
        stopReason: result.stopReason,
        multimodal: true,
        imageCount: input.images.length,
        estimatedCostUsd,
      },
    };
  }

  /**
   * Reflect on artifact - uses AI_MODEL_DEFAULT with strict JSON schema validation
   */
  async reflectOnArtifact(input: ReflectionInput): Promise<Critique> {
    const temps = this.getTemperatures();

    let checkResultsSummary = '';
    if (input.checkResults) {
      const checks = [];
      if (input.checkResults.typecheck) {
        checks.push(`TypeCheck: ${input.checkResults.typecheck.passed ? 'PASSED' : 'FAILED'}`);
        if (input.checkResults.typecheck.errors?.length) {
          checks.push(`  Errors: ${input.checkResults.typecheck.errors.slice(0, 3).join('; ')}`);
        }
      }
      if (input.checkResults.lint) {
        checks.push(`Lint: ${input.checkResults.lint.passed ? 'PASSED' : 'FAILED'}`);
      }
      if (input.checkResults.test) {
        checks.push(`Tests: ${input.checkResults.test.passed ? 'PASSED' : 'FAILED'}`);
      }
      if (input.checkResults.build) {
        checks.push(`Build: ${input.checkResults.build.passed ? 'PASSED' : 'FAILED'}`);
      }
      if (checks.length > 0) {
        checkResultsSummary = `\n\nStatic Check Results:\n${checks.join('\n')}`;
      }
    }

    const artifactStr =
      typeof input.artifact === 'string' ? input.artifact : JSON.stringify(input.artifact, null, 2);

    const userPrompt = `Review the following artifact and provide feedback:

${artifactStr.substring(0, 8000)}${artifactStr.length > 8000 ? '\n... (truncated)' : ''}
${input.context ? `\nContext: ${JSON.stringify(input.context)}` : ''}${checkResultsSummary}

Respond with ONLY the JSON critique object.`;

    const response = await this.chatCompletion(
      [
        { role: 'system', content: REFLECT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      this.config.modelDefault,
      { temperature: temps.reflect },
      'reflect'
    );

    return this.parseWithSchema(response.content, CritiqueSchema, 'reflectOnArtifact');
  }

  /**
   * Validate with strong model - uses AI_MODEL_VALIDATION with strict JSON schema validation
   */
  async validateWithStrongModel(input: ValidationInput): Promise<ValidationResult> {
    const temps = this.getTemperatures();

    const artifactStr =
      typeof input.artifact === 'string' ? input.artifact : JSON.stringify(input.artifact, null, 2);

    const contextParts: string[] = [];

    if (input.plan) {
      contextParts.push(`Plan: ${input.plan.steps.map((s) => s.title).join(' -> ')}`);
    }

    if (input.reflection) {
      contextParts.push(`Prior Reflection Issues: ${input.reflection.issues.join('; ')}`);
    }

    if (input.checkResults) {
      const checkSummary = Object.entries(input.checkResults)
        .map(([key, val]) => `${key}: ${val?.passed ? 'PASSED' : 'FAILED'}`)
        .join(', ');
      contextParts.push(`Check Results: ${checkSummary}`);
    }

    const userPrompt = `Perform final validation on the following artifact:

${artifactStr.substring(0, 10000)}${artifactStr.length > 10000 ? '\n... (truncated)' : ''}

${contextParts.length > 0 ? `Additional Context:\n${contextParts.join('\n')}` : ''}

Respond with ONLY the JSON validation result object.`;

    const response = await this.chatCompletion(
      [
        { role: 'system', content: VALIDATE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      this.config.modelValidation,
      { temperature: temps.validate },
      'validate'
    );

    return this.parseWithSchema(response.content, ValidationSchema, 'validateWithStrongModel');
  }
}

// =============================================================================
// Mock Implementation (for testing and development without API keys)
// =============================================================================

/**
 * Mock AI Service - deterministic responses for testing
 */
class MockAIService implements AIService {
  public planner: Planner;
  public reflector: Reflector;
  private observer?: AIServiceObserver;

  constructor(observer?: AIServiceObserver) {
    this.observer = observer;
    this.planner = {
      plan: (input: PlanInput) => this.planTask(input),
    };

    this.reflector = {
      critique: (input: {
        artifact: unknown;
        context?: unknown;
        checkResults?: ReflectionInput['checkResults'];
      }) =>
        this.reflectOnArtifact({
          artifact: input.artifact,
          context: input.context,
          checkResults: input.checkResults,
        }),
    };
  }

  getConfigSummary() {
    return {
      provider: 'mock',
      models: {
        default: 'mock-model',
        planner: 'mock-model',
        validation: 'mock-model',
      },
      baseUrl: 'mock://localhost',
      hasApiKey: true,
    };
  }

  async planTask(input: PlanInput): Promise<Plan> {
    const plan = {
      steps: [
        {
          id: 'step-1',
          title: `Analyze ${input.agent} requirements`,
          detail: `Goal: ${input.goal}`,
        },
        { id: 'step-2', title: 'Design solution architecture', detail: 'Mock design phase' },
        { id: 'step-3', title: 'Execute implementation', detail: 'Mock execution phase' },
        { id: 'step-4', title: 'Validate output', detail: 'Mock validation phase' },
      ],
      rationale: `Mock plan for ${input.agent} agent to achieve: ${input.goal}`,
    };
    this.observer?.onAiCall({
      purpose: 'plan',
      provider: 'mock',
      model: 'mock-model',
      success: true,
      content: {
        systemPrompt: '[mock] plan system prompt',
        userPrompt: `[mock] plan for agent=${input.agent}, goal=${input.goal}`,
        responseText: JSON.stringify(plan),
      },
    });
    return plan;
  }

  async generateWorkArtifact(input: WorkerInput): Promise<WorkerResult> {
    // Pipeline-aware mock responses based on system prompt keywords
    const sys = (input.systemPrompt ?? '').toLowerCase();
    let content: string;

    if (sys.includes('structuredspec') || sys.includes('structured spec') || sys.includes('spec')) {
      content = JSON.stringify({
        projectName: 'Mock Project',
        description: 'A mock project generated for testing',
        userStories: [
          {
            id: 'US-1',
            title: 'Basic UI',
            description: 'User can view the main page',
            acceptanceCriteria: ['Page loads', 'Title visible'],
          },
          {
            id: 'US-2',
            title: 'Data Display',
            description: 'User can see data list',
            acceptanceCriteria: ['List renders', 'Items clickable'],
          },
        ],
        acceptanceCriteria: [
          'App loads without errors',
          'Navigation works',
          'Data displays correctly',
        ],
        technicalConstraints: { stack: 'React + Vite + TypeScript' },
        outOfScope: ['Authentication', 'Payment processing'],
        confidence: 0.9,
      });
    } else if (sys.includes('clarification') || sys.includes('soru')) {
      content = JSON.stringify({ ready: true });
    } else if (
      sys.includes('proto') ||
      sys.includes('scaffold') ||
      sys.includes('code generation')
    ) {
      content = JSON.stringify([
        {
          filePath: 'src/App.tsx',
          content: 'export default function App() { return <div>Hello AKIS</div>; }',
        },
        {
          filePath: 'src/main.tsx',
          content:
            'import App from "./App"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(<App />);',
        },
        {
          filePath: 'package.json',
          content: '{"name":"mock-project","version":"0.1.0","scripts":{"dev":"vite"}}',
        },
        {
          filePath: 'index.html',
          content:
            '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
        },
      ]);
    } else if (sys.includes('trace') || sys.includes('playwright') || sys.includes('test')) {
      content = JSON.stringify([
        {
          filePath: 'tests/app.spec.ts',
          content:
            'import { test, expect } from "@playwright/test"; test("app loads", async ({ page }) => { await page.goto("/"); await expect(page.locator("div")).toBeVisible(); });',
        },
        {
          filePath: 'playwright.config.ts',
          content:
            'import { defineConfig } from "@playwright/test"; export default defineConfig({ testDir: "./tests" });',
        },
      ]);
    } else {
      content = `Mock generated content for task: ${input.task}`;
    }

    this.observer?.onAiCall({
      purpose: 'generate',
      provider: 'mock',
      model: 'mock-model',
      success: true,
      content: {
        systemPrompt: input.systemPrompt,
        userPrompt: input.task,
        responseText: content,
      },
    });

    return {
      content,
      metadata: {
        model: 'mock-model',
        task: input.task,
        mock: true,
      },
    };
  }

  async reflectOnArtifact(input: ReflectionInput): Promise<Critique> {
    const critique: Critique = {
      issues: [
        'Mock issue: Ensure all steps are executable',
        'Mock issue: Validate artifact completeness',
      ],
      recommendations: [
        'Mock recommendation: Add error handling',
        'Mock recommendation: Include validation checks',
      ],
      severity: 'low',
    };
    this.observer?.onAiCall({
      purpose: 'reflect',
      provider: 'mock',
      model: 'mock-model',
      success: true,
      content: {
        systemPrompt: '[mock] reflect system prompt',
        userPrompt:
          typeof input.artifact === 'string' ? input.artifact : JSON.stringify(input.artifact),
        responseText: JSON.stringify(critique),
      },
    });
    return critique;
  }

  async validateWithStrongModel(input: ValidationInput): Promise<ValidationResult> {
    const result: ValidationResult = {
      passed: true,
      confidence: 0.85,
      issues: [],
      suggestions: ['Mock suggestion: Consider adding more tests'],
      summary: 'Mock validation passed with high confidence',
    };
    this.observer?.onAiCall({
      purpose: 'validate',
      provider: 'mock',
      model: 'mock-model',
      success: true,
      content: {
        systemPrompt: '[mock] validate system prompt',
        userPrompt:
          typeof input.artifact === 'string' ? input.artifact : JSON.stringify(input.artifact),
        responseText: JSON.stringify(result),
      },
    });
    return result;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

// =============================================================================
// Tool-Calling Client (for AgenticLoop)
// =============================================================================

import type { ToolDefinition, AnthropicMessage, AnthropicResponse } from './tool-schemas.js';
import { toAnthropicTools } from './tool-schemas.js';

/**
 * Creates a tool-calling client for the AgenticLoop.
 * Uses the same Anthropic API credentials as AIService but calls with tools.
 */
export function createToolCallingClient(
  config?: AIConfig
): (
  messages: AnthropicMessage[],
  tools: ToolDefinition[],
  options?: { model?: string; maxTokens?: number; temperature?: number; system?: string }
) => Promise<AnthropicResponse> {
  const resolvedConfig = config || getAIConfig(getEnv());

  return async (messages, tools, options = {}) => {
    if (!resolvedConfig.apiKey || resolvedConfig.provider === 'mock') {
      // Mock response for tests
      return {
        id: 'mock',
        content: [{ type: 'text' as const, text: '{"mock": true}' }],
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    const model = resolveAnthropicModel(options.model ?? resolvedConfig.modelDefault);
    const endpoint = `${resolvedConfig.baseUrl}/v1/messages`;

    // Mirror the AIService caching behavior for the tool-calling loop so the
    // AgenticLoop also benefits from the 5-min Anthropic prompt cache TTL.
    // Static tool schemas + system prompt form the stable prefix on every
    // iteration of the same agent; user/tool results stay uncached.
    const systemForBody = options.system ? buildCacheableSystemBlocks(options.system) : undefined;

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 16384,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: toAnthropicTools(tools),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(systemForBody !== undefined && { system: systemForBody }),
    };

    const MAX_TOOL_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    for (let attempt = 0; attempt <= MAX_TOOL_RETRIES; attempt++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': resolvedConfig.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return (await response.json()) as AnthropicResponse;
      }

      const isRetryable = [429, 500, 502, 503, 504].includes(response.status);
      if (isRetryable && attempt < MAX_TOOL_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const errorText = await response.text().catch(() => 'Unknown error');
      throw new AIProviderError(
        'AI_PROVIDER_ERROR',
        `Tool-calling API error (${response.status}): ${errorText.substring(0, 200)}`,
        resolvedConfig.provider,
        response.status
      );
    }

    // Should not reach here, but satisfy TypeScript
    throw new AIProviderError(
      'AI_PROVIDER_ERROR',
      'Tool-calling request failed after retries',
      resolvedConfig.provider,
      500
    );
  };
}

/**
 * Create AIService instance based on configuration
 * Uses getAIConfig() to resolve environment variables with legacy fallbacks
 */
export function createAIService(
  config?: AIConfig,
  observer?: AIServiceObserver,
  runtimeOptions: AIServiceRuntimeOptions = {}
): AIService {
  // ALWAYS use mock in test environment to prevent external API calls during tests
  if (process.env.NODE_ENV === 'test') {
    logger.info('[AIService] Using mock provider (test environment)');
    return new MockAIService(observer);
  }

  // If no config provided, get from environment
  const resolvedConfig = config || getAIConfig(getEnv());

  if (resolvedConfig.provider === 'mock') {
    logger.info('[AIService] Using mock provider (no real AI calls)');
    return new MockAIService(observer);
  }

  // P1a: OpenAI runtime is now active. RealAIService routes via
  // buildOpenAIRequest + parseOpenAIResponse when provider === 'openai'.
  // (Previously a defensive throw lived here per PR-A.)

  if (!resolvedConfig.apiKey) {
    logger.warn(
      `[AIService] No API key found for provider "${resolvedConfig.provider}", falling back to mock`
    );
    return new MockAIService(observer);
  }

  logger.info(`[AIService] Using ${resolvedConfig.provider} provider`);
  logger.info(
    `[AIService] Models: default=${resolvedConfig.modelDefault}, planner=${resolvedConfig.modelPlanner}, validation=${resolvedConfig.modelValidation}`
  );

  return new RealAIService(resolvedConfig, observer, runtimeOptions);
}

// Note: Planner and Reflector interfaces are already exported above
