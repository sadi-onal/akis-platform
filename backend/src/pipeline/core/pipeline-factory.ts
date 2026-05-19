/**
 * Pipeline factory — creates the PipelineOrchestrator
 * with all agent dependencies wired up from the main backend services.
 */
import { PipelineOrchestrator, type PipelineStore } from './orchestrator/PipelineOrchestrator.js';
import { ScribeAgent } from '../agents/scribe/ScribeAgent.js';
import { ProtoAgent, type ProtoAIDeps, type ProtoGitHubDeps } from '../agents/proto/ProtoAgent.js';
import { TraceAgent, type TraceAIDeps, type TraceGitHubDeps } from '../agents/trace/TraceAgent.js';
import { CriticAgent, type CriticAIDeps } from '../agents/critic/CriticAgent.js';
import { RepoContextAgent } from '../agents/repo-context/RepoContextAgent.js';
import type { ScribeAIDeps } from '../agents/scribe/ScribeAgent.js';
import { DrizzlePipelineStore } from '../db/DrizzlePipelineStore.js';
import { PipelineReconciler } from './PipelineReconciler.js';
import { db } from '../../db/client.js';
import type { AgenticLoopDeps } from './AgenticLoop.js';
import { AgentActivityService } from '../services/AgentActivityService.js';
import type { SkillRegistry } from '../agents/skills/index.js';
import { getEnv } from '../../config/env.js';

/**
 * Resolve the CriticAgent approval threshold from env. Falls back to the
 * default (75) if `getEnv()` throws — e.g. when the orchestrator is booted
 * from a unit test without a full env. Reads `process.env` directly first
 * to avoid the heavy zod parse cost for a single integer.
 */
function resolveCriticApprovalThreshold(): number | undefined {
  const raw = process.env.CRITIC_APPROVAL_THRESHOLD;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, Math.floor(parsed)));
    }
  }
  try {
    return getEnv().CRITIC_APPROVAL_THRESHOLD;
  } catch {
    return undefined;
  }
}

// ─── AI Adapter ──────────────────────────────────
// Bridges the existing AIService to agent AI deps interfaces.

export interface AIServiceLike {
  generateWorkArtifact(input: {
    systemPrompt?: string;
    task: string;
    context?: unknown;
    maxTokens?: number;
    modelOverride?: string;
  }): Promise<{ content: string; metadata?: Record<string, unknown> }>;
  /**
   * Optional multimodal path for providers that support image input (currently
   * Anthropic). When defined, agents with image attachments call this instead
   * of {@link generateWorkArtifact}. Issue #402 step 2.
   */
  generateMultimodalArtifact?(input: {
    systemPrompt: string;
    task: string;
    images: readonly import('../../services/ai/multimodalClient.js').AnthropicImageBlock[];
    maxTokens?: number;
    modelOverride?: string;
  }): Promise<{ content: string; metadata?: Record<string, unknown> }>;
}

/** Callback type for accumulating token usage per AI call. */
export type TokenUsageCallback = (usage: { inputTokens: number; outputTokens: number }) => void;

/**
 * Wraps generateWorkArtifact: returns content and optionally reports token usage via callback.
 */
function makeGenerateText(
  aiService: AIServiceLike,
  maxTokens: number,
  model?: string,
  onTokenUsage?: TokenUsageCallback,
): (systemPrompt: string, userPrompt: string) => Promise<string> {
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const result = await aiService.generateWorkArtifact({
      systemPrompt,
      task: userPrompt,
      maxTokens,
      modelOverride: model,
    });
    // Report token usage if callback provided and metadata has usage info
    if (onTokenUsage && result.metadata?.usage) {
      const u = result.metadata.usage as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
      const inp = u.inputTokens ?? u.input_tokens ?? 0;
      const out = u.outputTokens ?? u.output_tokens ?? 0;
      if (inp > 0 || out > 0) {
        onTokenUsage({ inputTokens: inp, outputTokens: out });
      }
    }
    return result.content;
  };
}

function createScribeAIDeps(aiService: AIServiceLike, model?: string, onTokenUsage?: TokenUsageCallback): ScribeAIDeps {
  const deps: ScribeAIDeps = {
    generateText: makeGenerateText(aiService, 8192, model, onTokenUsage),
  };
  // Wire the multimodal path only when the AIService actually supports it.
  // Mock stores and non-Anthropic providers leave `generateMultimodalArtifact`
  // undefined, and Scribe falls back to `generateText`.
  if (aiService.generateMultimodalArtifact) {
    const mmFn = aiService.generateMultimodalArtifact.bind(aiService);
    deps.generateTextWithImages = async (systemPrompt, userPrompt, images) => {
      const result = await mmFn({
        systemPrompt,
        task: userPrompt,
        images,
        maxTokens: 8192,
        modelOverride: model,
      });
      if (onTokenUsage && result.metadata?.usage) {
        const u = result.metadata.usage as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
        const inp = u.inputTokens ?? u.input_tokens ?? 0;
        const out = u.outputTokens ?? u.output_tokens ?? 0;
        if (inp > 0 || out > 0) onTokenUsage({ inputTokens: inp, outputTokens: out });
      }
      return result.content;
    };
  }
  return deps;
}

function createProtoAIDeps(aiService: AIServiceLike, model?: string, onTokenUsage?: TokenUsageCallback): ProtoAIDeps {
  const deps: ProtoAIDeps = {
    generateText: makeGenerateText(aiService, 16384, model, onTokenUsage),
  };
  // Wire the multimodal path only when the AIService actually supports it.
  // Mock stores and non-Anthropic providers leave `generateMultimodalArtifact`
  // undefined, and Proto falls back to `generateText`. Issue #427 BUG-19.
  if (aiService.generateMultimodalArtifact) {
    const mmFn = aiService.generateMultimodalArtifact.bind(aiService);
    deps.generateTextWithImages = async (systemPrompt, userPrompt, images) => {
      const result = await mmFn({
        systemPrompt,
        task: userPrompt,
        images,
        maxTokens: 16384,
        modelOverride: model,
      });
      if (onTokenUsage && result.metadata?.usage) {
        const u = result.metadata.usage as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
        const inp = u.inputTokens ?? u.input_tokens ?? 0;
        const out = u.outputTokens ?? u.output_tokens ?? 0;
        if (inp > 0 || out > 0) onTokenUsage({ inputTokens: inp, outputTokens: out });
      }
      return result.content;
    };
  }
  return deps;
}

function createTraceAIDeps(aiService: AIServiceLike, model?: string, onTokenUsage?: TokenUsageCallback): TraceAIDeps {
  // PR-H (2026-05-19): bumped from 32 768 → 64 000 because manual-test logs on
  // 2026-05-19 showed Trace responses hitting the cap (responseLen 33-45K) and
  // truncating the JSON closing fence — three retries all failed JSON parse.
  // 64K is the documented Anthropic max for Sonnet/Haiku 4-class models.
  const TRACE_MAX_TOKENS = 64_000;
  const deps: TraceAIDeps = {
    generateText: makeGenerateText(aiService, TRACE_MAX_TOKENS, model, onTokenUsage),
  };
  // Wire the multimodal path only when the AIService actually supports it.
  // Mock stores and non-Anthropic providers leave `generateMultimodalArtifact`
  // undefined, and Trace falls back to `generateText`. Issue #464 BUG-C.
  if (aiService.generateMultimodalArtifact) {
    const mmFn = aiService.generateMultimodalArtifact.bind(aiService);
    deps.generateTextWithImages = async (systemPrompt, userPrompt, images) => {
      const result = await mmFn({
        systemPrompt,
        task: userPrompt,
        images,
        maxTokens: TRACE_MAX_TOKENS,
        modelOverride: model,
      });
      if (onTokenUsage && result.metadata?.usage) {
        const u = result.metadata.usage as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
        const inp = u.inputTokens ?? u.input_tokens ?? 0;
        const out = u.outputTokens ?? u.output_tokens ?? 0;
        if (inp > 0 || out > 0) onTokenUsage({ inputTokens: inp, outputTokens: out });
      }
      return result.content;
    };
  }
  return deps;
}

function createCriticAIDeps(aiService: AIServiceLike, model?: string, onTokenUsage?: TokenUsageCallback): CriticAIDeps {
  return { generateText: makeGenerateText(aiService, 8192, model, onTokenUsage) };
}

function createRepoContextAIDeps(aiService: AIServiceLike, model?: string) {
  return {
    async generateText(systemPrompt: string, userPrompt: string): Promise<string> {
      const result = await aiService.generateWorkArtifact({
        systemPrompt,
        task: userPrompt,
        maxTokens: 4096,
        modelOverride: model,
      });
      return result.content;
    },
  };
}

// ─── GitHub Adapter ──────────────────────────────
// Bridges the existing GitHubMCPService to agent GitHub deps interfaces.

export interface GitHubServiceLike {
  createRepository(owner: string, name: string, isPrivate: boolean): Promise<{ url: string }>;
  createBranch(owner: string, repo: string, branch: string, fromBranch?: string): Promise<void>;
  commitFile(owner: string, repo: string, branch: string, filePath: string, content: string, message: string): Promise<void>;
  pushFiles?(owner: string, repo: string, branch: string, files: Array<{ path: string; content: string }>, message: string): Promise<void>;
  createPR(owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<{ url: string }>;
  listFiles(owner: string, repo: string, branch: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, branch: string, filePath: string): Promise<string>;
}

function createProtoGitHubDeps(github: GitHubServiceLike): ProtoGitHubDeps {
  return {
    createRepository: (owner, name, isPrivate) => github.createRepository(owner, name, isPrivate),
    createBranch: (owner, repo, branch, fromBranch) => github.createBranch(owner, repo, branch, fromBranch),
    commitFile: (owner, repo, branch, filePath, content, message) =>
      github.commitFile(owner, repo, branch, filePath, content, message),
    pushFiles: github.pushFiles
      ? (owner, repo, branch, files, message) => github.pushFiles!(owner, repo, branch, files, message)
      : undefined,
    createPR: (owner, repo, title, body, head, base) =>
      github.createPR(owner, repo, title, body, head, base),
  };
}

function createTraceGitHubDeps(github: GitHubServiceLike): TraceGitHubDeps {
  return {
    listFiles: (owner, repo, branch) => github.listFiles(owner, repo, branch),
    getFileContent: (owner, repo, branch, filePath) => github.getFileContent(owner, repo, branch, filePath),
    commitFile: (owner, repo, branch, filePath, content, message) =>
      github.commitFile(owner, repo, branch, filePath, content, message),
    pushFiles: github.pushFiles
      ? (owner, repo, branch, files, message) => github.pushFiles!(owner, repo, branch, files, message)
      : undefined,
    createBranch: (owner, repo, branch, fromBranch) => github.createBranch(owner, repo, branch, fromBranch),
    createPR: (owner, repo, title, body, head, base) =>
      github.createPR(owner, repo, title, body, head, base),
  };
}

// ─── Factory ─────────────────────────────────────

export interface CreatePipelineOrchestratorOptions {
  aiService: AIServiceLike;
  /** Factory: creates a per-user GitHub adapter from a token */
  createGitHubService: (token: string) => GitHubServiceLike;
  /** Fallback GitHub service (platform token) for default agents */
  fallbackGitHubService?: GitHubServiceLike;
  getGitHubOwner: (userId: string) => Promise<string>;
  /** Retrieves a per-user GitHub token (returns null if user has no token) */
  getGitHubToken: (userId: string) => Promise<string | null>;
  store?: PipelineStore;
  /** Optional: tool-calling client for agentic loop (Claude API tool_use) */
  agenticDeps?: AgenticLoopDeps;
  /** Optional: pre-initialized skill registry for agent prompt enrichment */
  skillRegistry?: SkillRegistry;
}

export function createAgentsForModel(
  aiService: AIServiceLike,
  githubService: GitHubServiceLike,
  model?: string,
  agenticDeps?: AgenticLoopDeps,
  onTokenUsage?: TokenUsageCallback,
  skillRegistry?: SkillRegistry,
) {
  const scribeAI = createScribeAIDeps(aiService, model, onTokenUsage);
  const protoAI = createProtoAIDeps(aiService, model, onTokenUsage);
  const traceAI = createTraceAIDeps(aiService, model, onTokenUsage);
  const criticAI = createCriticAIDeps(aiService, model, onTokenUsage);
  const protoGH = createProtoGitHubDeps(githubService);
  const traceGH = createTraceGitHubDeps(githubService);

  return {
    scribe: new ScribeAgent(scribeAI, skillRegistry),
    proto: new ProtoAgent(protoAI, protoGH, agenticDeps, skillRegistry),
    trace: new TraceAgent(traceAI, traceGH, agenticDeps, skillRegistry),
    critic: new CriticAgent(criticAI, skillRegistry, resolveCriticApprovalThreshold()),
  };
}

export function createRepoContextAgent(
  aiService: AIServiceLike,
  githubService: GitHubServiceLike,
  model?: string,
): RepoContextAgent {
  const ai = createRepoContextAIDeps(aiService, model);
  const github = {
    listFiles: (owner: string, repo: string, branch: string) => githubService.listFiles(owner, repo, branch),
    getFileContent: (owner: string, repo: string, branch: string, filePath: string) =>
      githubService.getFileContent(owner, repo, branch, filePath),
  };
  return new RepoContextAgent(ai, github);
}

export interface PipelineSystem {
  orchestrator: PipelineOrchestrator;
  reconciler: PipelineReconciler;
}

export function createPipelineOrchestrator(opts: CreatePipelineOrchestratorOptions): PipelineOrchestrator {
  return createPipelineSystem(opts).orchestrator;
}

export function createPipelineSystem(opts: CreatePipelineOrchestratorOptions): PipelineSystem {
  const store = opts.store ?? new DrizzlePipelineStore(db);

  // Default agents use fallback (platform token) service — used for Scribe (no GitHub needed)
  // Proto/Trace will get per-user adapters at runtime via orchestrator
  const fallbackGH = opts.fallbackGitHubService ?? opts.createGitHubService('');
  const defaultAgents = createAgentsForModel(
    opts.aiService,
    fallbackGH,
    undefined,
    opts.agenticDeps,
    undefined,
    opts.skillRegistry,
  );

  const orchestrator = new PipelineOrchestrator(
    store,
    defaultAgents.scribe,
    defaultAgents.proto,
    defaultAgents.trace,
    opts.getGitHubOwner,
    opts.getGitHubToken,
    opts.createGitHubService,
    undefined, // emit
    (model, githubService?, onTokenUsage?) =>
      createAgentsForModel(
        opts.aiService,
        githubService ?? fallbackGH,
        model,
        opts.agenticDeps,
        onTokenUsage,
        opts.skillRegistry,
      ),
  );

  // Wire agent activity logging for integrity metrics
  const activityService = new AgentActivityService({ db });
  orchestrator.setActivityLogger(activityService);

  // Wire Level 3: CriticAgent for adversarial review
  const criticAI = createCriticAIDeps(opts.aiService);
  orchestrator.setCriticAgent(
    new CriticAgent(criticAI, opts.skillRegistry, resolveCriticApprovalThreshold()),
  );

  // Wire AI service for RepoContextAgent
  orchestrator.setAIService(opts.aiService);

  const reconciler = new PipelineReconciler(store);
  return { orchestrator, reconciler };
}
