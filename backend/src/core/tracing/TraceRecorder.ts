/**
 * TraceRecorder - Utility for recording job execution traces
 * S1.0: Scribe Observability - structured trace timeline
 * S2.0.3: Real-time SSE streaming via JobEventBus
 */

import { db } from '../../db/client.js';
import { jobTraces, jobArtifacts, jobAiCalls, type NewJobTrace, type NewJobArtifact, type NewJobAiCall } from '../../db/schema.js';
import { jobEventBus } from '../events/JobEventBus.js';
import { logger } from '../../lib/logger.js';

export type TraceEventType = 
  | 'step_start'
  | 'step_complete'
  | 'step_failed'
  | 'doc_read'
  | 'file_created'
  | 'file_modified'
  | 'mcp_connect'
  | 'mcp_call'
  | 'ai_call'
  | 'ai_parse_error'
  | 'error'
  | 'info'
  // S1.1: Explainability types
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'plan_step'
  | 'reasoning';

export type TraceStatus = 'success' | 'failed' | 'warning' | 'info';

export interface TraceEvent {
  eventType: TraceEventType;
  title: string;
  stepId?: string;
  detail?: Record<string, unknown>;
  durationMs?: number;
  status?: TraceStatus;
  correlationId?: string;
  gatewayUrl?: string;
  errorCode?: string;
  // S1.1: Explainability fields
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  reasoningSummary?: string;
  askedWhat?: string;
  didWhat?: string;
  whyReason?: string;
}

/**
 * Explainability event for tool calls with Asked/Did/Why/Output
 */
export interface ExplainableToolCall {
  toolName: string;
  /** What did we ask the tool to do? (user-facing) */
  asked: string;
  /** What action was taken? (user-facing) */
  did: string;
  /** Why was this action taken? (2-4 sentences, never raw chain-of-thought) */
  why: string;
  /** Summary of input arguments (redacted) */
  inputSummary?: string;
  /** Summary of output/result (redacted) */
  outputSummary?: string;
  /** Was the call successful? */
  success: boolean;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Correlation ID for tracing */
  correlationId?: string;
  /** Raw detail (server-side only, will be redacted) */
  rawDetail?: Record<string, unknown>;
}

export interface ArtifactRecord {
  artifactType: 'doc_read' | 'file_created' | 'file_modified' | 'file_deleted' | 'file_preview';
  path: string;
  operation: 'read' | 'create' | 'modify' | 'delete' | 'preview';
  sizeBytes?: number;
  contentHash?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Maximum size for trace detail JSON (to prevent DB bloat)
 */
const MAX_DETAIL_SIZE = 10 * 1024; // 10KB

/**
 * Maximum size for artifact preview
 */
const MAX_PREVIEW_SIZE = 1024; // 1KB

/**
 * Truncate and sanitize trace detail to prevent DB bloat
 */
function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  
  const json = JSON.stringify(detail);
  if (json.length <= MAX_DETAIL_SIZE) {
    return detail;
  }
  
  // Truncate large details
  return {
    _truncated: true,
    _originalSize: json.length,
    summary: Object.keys(detail).join(', '),
  };
}

/**
 * Truncate preview text
 */
function truncatePreview(preview: string | undefined): string | null {
  if (!preview) return null;
  const redacted = redactText(preview);
  if (redacted.length <= MAX_PREVIEW_SIZE) return redacted;
  return redacted.substring(0, MAX_PREVIEW_SIZE - 20) + '\n...[truncated]';
}

/**
 * Maximum size for diff preview
 */
const MAX_DIFF_SIZE = 2 * 1024; // 2KB

/**
 * Truncate diff preview text
 */
function truncateDiff(diff: string | undefined): string | null {
  if (!diff) return null;
  const redacted = redactText(diff);
  if (redacted.length <= MAX_DIFF_SIZE) return redacted;
  return redacted.substring(0, MAX_DIFF_SIZE - 30) + '\n... [diff truncated]';
}

/**
 * Patterns for sensitive data that must be redacted
 */
const SENSITIVE_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /bearer/i,
];

/**
 * Token patterns to redact in text
 */
const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9_]+/g,       // GitHub PAT
  /gho_[A-Za-z0-9_]+/g,       // GitHub OAuth
  /ghs_[A-Za-z0-9_]+/g,       // GitHub App
  /ghr_[A-Za-z0-9_]+/g,       // GitHub Refresh
  /sk-[A-Za-z0-9_-]+/g,       // OpenAI
  /Bearer\s+[A-Za-z0-9._-]+/gi, // Bearer tokens
];

/**
 * Redact sensitive values from detail objects
 */
function redactSensitiveData(detail: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(detail)) {
    const isSensitive = SENSITIVE_PATTERNS.some(p => p.test(key));
    
    if (isSensitive && typeof value === 'string') {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = redactText(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (typeof entry === 'string') {
          return redactText(entry);
        }
        if (typeof entry === 'object' && entry !== null) {
          return redactSensitiveData(entry as Record<string, unknown>);
        }
        return entry;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Redact token patterns from text
 */
function redactText(text: string): string {
  let result = text;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * TraceRecorder options
 */
export interface TraceRecorderOptions {
  /** Enable live SSE streaming via JobEventBus (default: true) */
  liveStreaming?: boolean;
  /** Batch flush interval in ms (0 = no auto-flush, default: 0) */
  batchFlushIntervalMs?: number;
}

/**
 * TraceRecorder class for recording job execution traces
 * S2.0.3: Now supports real-time SSE streaming
 */
export class TraceRecorder {
  private jobId: string;
  private pendingTraces: NewJobTrace[] = [];
  private pendingArtifacts: NewJobArtifact[] = [];
  private pendingAiCalls: NewJobAiCall[] = [];
  private stepTimers: Map<string, number> = new Map();
  private aiCallIndex: number = 0;
  private liveStreaming: boolean;
  private batchFlushTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushTime: number = Date.now();

  constructor(jobId: string, options: TraceRecorderOptions = {}) {
    this.jobId = jobId;
    this.liveStreaming = options.liveStreaming !== false; // Default: true
    
    // Set up batch flush interval if specified
    if (options.batchFlushIntervalMs && options.batchFlushIntervalMs > 0) {
      this.batchFlushTimer = setInterval(() => {
        void this.flushIfNeeded();
      }, options.batchFlushIntervalMs);
    }
  }

  /**
   * Flush to DB if there are pending items and enough time has passed
   */
  private async flushIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastFlush = now - this.lastFlushTime;
    const hasPendingItems = this.pendingTraces.length > 0 || 
                           this.pendingArtifacts.length > 0 || 
                           this.pendingAiCalls.length > 0;
    
    // Flush if we have >= 10 items or >= 500ms since last flush
    if (hasPendingItems && (this.pendingTraces.length >= 10 || timeSinceLastFlush >= 500)) {
      try {
        await this.flush();
      } catch (err) {
        logger.error(`[TraceRecorder] Auto-flush failed: ${err}`);
      }
    }
  }

  /**
   * Emit trace event to SSE stream (real-time)
   */
  private emitToStream(event: TraceEvent): void {
    if (!this.liveStreaming) return;
    
    jobEventBus.emitTrace(this.jobId, {
      eventType: event.eventType,
      stepId: event.stepId,
      title: event.title,
      detail: event.detail,
      durationMs: event.durationMs,
      status: (event.status as 'success' | 'failed' | 'warning' | 'info') || 'info',
      correlationId: event.correlationId,
      toolName: event.toolName,
      inputSummary: event.inputSummary,
      outputSummary: event.outputSummary,
      reasoningSummary: event.reasoningSummary,
      askedWhat: event.askedWhat,
      didWhat: event.didWhat,
      whyReason: event.whyReason,
    });
  }

  /**
   * Emit artifact event to SSE stream (real-time)
   */
  private emitArtifactToStream(artifact: ArtifactRecord): void {
    if (!this.liveStreaming) return;
    
    const kind = artifact.artifactType === 'doc_read' ? 'doc_read' as const :
                 artifact.artifactType === 'file_created' ? 'file' as const :
                 artifact.artifactType === 'file_modified' ? 'file' as const :
                 artifact.artifactType === 'file_preview' ? 'file' as const : 'file' as const;
    
    jobEventBus.emitArtifact(this.jobId, {
      kind,
      label: artifact.path.split('/').pop() || artifact.path,
      path: artifact.path,
      operation: artifact.operation,
      preview: artifact.preview,
      sizeBytes: artifact.sizeBytes,
    });
  }

  /**
   * Record a trace event
   */
  async trace(event: TraceEvent): Promise<void> {
    const detail = event.detail ? sanitizeDetail(redactSensitiveData(event.detail)) : null;
    
    const traceRow: NewJobTrace = {
      jobId: this.jobId,
      eventType: event.eventType,
      stepId: event.stepId,
      title: event.title.substring(0, 500), // Ensure title fits
      detail,
      durationMs: event.durationMs,
      status: event.status || 'info',
      correlationId: event.correlationId,
      gatewayUrl: event.gatewayUrl,
      errorCode: event.errorCode,
      // S1.1: Explainability fields
      toolName: event.toolName?.substring(0, 100),
      inputSummary: event.inputSummary ? redactText(event.inputSummary) : null,
      outputSummary: event.outputSummary ? redactText(event.outputSummary) : null,
      reasoningSummary: event.reasoningSummary?.substring(0, 1000),
      askedWhat: event.askedWhat ? redactText(event.askedWhat) : null,
      didWhat: event.didWhat ? redactText(event.didWhat) : null,
      whyReason: event.whyReason ? redactText(event.whyReason) : null,
    };

    this.pendingTraces.push(traceRow);
    
    // S2.0.3: Emit to SSE stream for real-time updates
    this.emitToStream(event);
  }

  /**
   * Record an artifact
   */
  async recordArtifact(artifact: ArtifactRecord): Promise<void> {
    const artifactRow: NewJobArtifact = {
      jobId: this.jobId,
      artifactType: artifact.artifactType,
      path: artifact.path.substring(0, 1000),
      operation: artifact.operation,
      sizeBytes: artifact.sizeBytes,
      contentHash: artifact.contentHash,
      preview: truncatePreview(artifact.preview),
      metadata: artifact.metadata
        ? sanitizeDetail(redactSensitiveData(artifact.metadata))
        : null,
    };

    this.pendingArtifacts.push(artifactRow);
    
    // S2.0.3: Emit to SSE stream for real-time updates
    this.emitArtifactToStream(artifact);
  }

  /**
   * Start timing a step
   */
  startStep(stepId: string, title: string): void {
    this.stepTimers.set(stepId, Date.now());
    void this.trace({
      eventType: 'step_start',
      stepId,
      title,
      status: 'info',
    });
  }

  /**
   * Complete a step with success
   */
  completeStep(stepId: string, title: string, detail?: Record<string, unknown>): void {
    const startTime = this.stepTimers.get(stepId);
    const durationMs = startTime ? Date.now() - startTime : undefined;
    this.stepTimers.delete(stepId);
    
    void this.trace({
      eventType: 'step_complete',
      stepId,
      title,
      detail,
      durationMs,
      status: 'success',
    });
  }

  /**
   * Fail a step
   */
  failStep(stepId: string, title: string, error: string, errorCode?: string): void {
    const startTime = this.stepTimers.get(stepId);
    const durationMs = startTime ? Date.now() - startTime : undefined;
    this.stepTimers.delete(stepId);
    
    void this.trace({
      eventType: 'step_failed',
      stepId,
      title,
      detail: { error },
      durationMs,
      status: 'failed',
      errorCode,
    });
  }

  /**
   * Record a document read
   */
  recordDocRead(path: string, sizeBytes?: number, preview?: string): void {
    void this.trace({
      eventType: 'doc_read',
      title: `Read: ${path}`,
      detail: { path, sizeBytes },
      status: 'success',
    });
    
    void this.recordArtifact({
      artifactType: 'doc_read',
      path,
      operation: 'read',
      sizeBytes,
      preview,
    });
  }

  /**
   * Record a file creation
   */
  recordFileCreated(path: string, sizeBytes?: number, preview?: string): void {
    void this.trace({
      eventType: 'file_created',
      title: `Created: ${path}`,
      detail: { path, sizeBytes },
      status: 'success',
    });
    
    void this.recordArtifact({
      artifactType: 'file_created',
      path,
      operation: 'create',
      sizeBytes,
      preview,
    });
  }

  /**
   * Record an MCP connection attempt
   */
  recordMcpConnect(gatewayUrl: string, success: boolean, correlationId?: string, errorCode?: string): void {
    void this.trace({
      eventType: 'mcp_connect',
      title: success ? 'MCP Gateway connected' : 'MCP Gateway connection failed',
      gatewayUrl,
      correlationId,
      status: success ? 'success' : 'failed',
      errorCode,
    });
  }

  /**
   * Record an MCP tool call
   */
  recordMcpCall(toolName: string, success: boolean, durationMs?: number, correlationId?: string, detail?: Record<string, unknown>): void {
    void this.trace({
      eventType: 'mcp_call',
      title: `MCP: ${toolName}`,
      detail,
      durationMs,
      correlationId,
      status: success ? 'success' : 'failed',
    });
  }

  /**
   * Record an AI call with detailed metrics for breakdown
   * Persists to both jobTraces (for timeline) and jobAiCalls (for metrics breakdown)
   */
  recordAiCall(
    purpose: string,
    success: boolean,
    durationMs?: number,
    detail?: {
      provider?: string;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      estimatedCostUsd?: number;
      errorCode?: string;
    }
  ): void {
    // Record to job_traces for timeline view
    void this.trace({
      eventType: 'ai_call',
      title: `AI: ${purpose}`,
      detail: detail as Record<string, unknown>,
      durationMs,
      status: success ? 'success' : 'failed',
    });

    // Record to job_ai_calls for metrics breakdown (if we have provider/model)
    if (detail?.provider && detail?.model) {
      const aiCallRecord: NewJobAiCall = {
        jobId: this.jobId,
        callIndex: this.aiCallIndex++,
        provider: detail.provider,
        model: detail.model,
        purpose: purpose.substring(0, 255),
        inputTokens: detail.usage?.inputTokens ?? null,
        outputTokens: detail.usage?.outputTokens ?? null,
        totalTokens: detail.usage?.totalTokens ?? null,
        durationMs: durationMs ?? null,
        estimatedCostUsd: detail.estimatedCostUsd !== undefined ? String(detail.estimatedCostUsd) : null,
        success,
        errorCode: detail.errorCode ?? null,
      };
      this.pendingAiCalls.push(aiCallRecord);
      
      // S2.0.3: Emit to SSE stream for real-time updates
      if (this.liveStreaming) {
        jobEventBus.emitAiCall(this.jobId, {
          purpose,
          provider: detail.provider,
          model: detail.model,
          durationMs,
          tokens: detail.usage ? {
            input: detail.usage.inputTokens,
            output: detail.usage.outputTokens,
            total: detail.usage.totalTokens,
          } : undefined,
          ok: success,
          errorCode: detail.errorCode,
        });
      }
    }
  }

  /**
   * Record an AI parse error (fallback used)
   */
  recordAiParseError(context: string, fallbackUsed: string): void {
    void this.trace({
      eventType: 'ai_parse_error',
      title: `AI parse error: ${context}`,
      detail: { context, fallbackUsed },
      status: 'warning',
    });
  }

  /**
   * Record a general error
   */
  recordError(title: string, errorCode?: string, detail?: Record<string, unknown>): void {
    void this.trace({
      eventType: 'error',
      title,
      detail,
      errorCode,
      status: 'failed',
    });
  }

  /**
   * Record an info event
   */
  recordInfo(title: string, detail?: Record<string, unknown>): void {
    void this.trace({
      eventType: 'info',
      title,
      detail,
      status: 'info',
    });
  }

  // =========================================================================
  // S1.1: Explainability Methods
  // =========================================================================

  /**
   * Record an explainable tool call with Asked/Did/Why/Output
   * This is the primary method for recording tool interactions with reasoning
   */
  recordToolCall(call: ExplainableToolCall): void {
    void this.trace({
      eventType: 'tool_call',
      title: `Tool: ${call.toolName}`,
      toolName: call.toolName,
      askedWhat: call.asked,
      didWhat: call.did,
      whyReason: call.why,
      inputSummary: call.inputSummary,
      outputSummary: call.outputSummary,
      durationMs: call.durationMs,
      correlationId: call.correlationId,
      detail: call.rawDetail,
      status: call.success ? 'success' : 'failed',
    });
    
    // S2.0.3: Emit to SSE stream for real-time updates
    if (this.liveStreaming) {
      jobEventBus.emitToolCall(this.jobId, {
        toolName: call.toolName,
        provider: 'mcp',
        inputSummary: call.inputSummary,
        durationMs: call.durationMs,
        ok: call.success,
        errorSummary: call.success ? undefined : 'Tool call failed',
        correlationId: call.correlationId,
        asked: call.asked,
        did: call.did,
        why: call.why,
      });
    }
  }

  /**
   * Record a decision point with reasoning
   * Use this when the agent makes a significant decision
   */
  recordDecision(options: {
    title: string;
    decision: string;
    reasoning: string;
    alternatives?: string[];
    stepId?: string;
  }): void {
    void this.trace({
      eventType: 'decision',
      title: options.title,
      stepId: options.stepId,
      didWhat: options.decision,
      reasoningSummary: options.reasoning,
      detail: options.alternatives ? { alternatives: options.alternatives } : undefined,
      status: 'info',
    });
  }

  /**
   * Record a plan step with reasoning
   */
  recordPlanStep(options: {
    stepId: string;
    title: string;
    description: string;
    reasoning: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }): void {
    void this.trace({
      eventType: 'plan_step',
      title: options.title,
      stepId: options.stepId,
      didWhat: options.description,
      reasoningSummary: options.reasoning,
      status: options.status === 'failed' ? 'failed' : 
              options.status === 'completed' ? 'success' : 'info',
    });
  }

  /**
   * Record a reasoning summary for the current execution phase
   * This is a user-facing summary (2-4 sentences), never raw chain-of-thought
   */
  recordReasoning(options: {
    phase: string;
    summary: string;
    stepId?: string;
  }): void {
    void this.trace({
      eventType: 'reasoning',
      title: `Reasoning: ${options.phase}`,
      stepId: options.stepId,
      reasoningSummary: options.summary,
      status: 'info',
    });
  }

  /**
   * Record a file modification with diff preview
   */
  recordFileModified(options: {
    path: string;
    sizeBytes?: number;
    preview?: string;
    diffPreview?: string;
    linesAdded?: number;
    linesRemoved?: number;
  }): void {
    void this.trace({
      eventType: 'file_modified',
      title: `Modified: ${options.path}`,
      detail: { 
        path: options.path, 
        sizeBytes: options.sizeBytes,
        linesAdded: options.linesAdded,
        linesRemoved: options.linesRemoved,
      },
      status: 'success',
    });
    
    void this.recordArtifact({
      artifactType: 'file_modified',
      path: options.path,
      operation: 'modify',
      sizeBytes: options.sizeBytes,
      preview: options.preview,
    });
    
    // Store diff info in metadata for the artifact
    if (options.diffPreview || options.linesAdded !== undefined || options.linesRemoved !== undefined) {
      // The artifact was just pushed, update its metadata
      const lastArtifact = this.pendingArtifacts[this.pendingArtifacts.length - 1];
      if (lastArtifact) {
        lastArtifact.metadata = {
          ...((lastArtifact.metadata as Record<string, unknown>) || {}),
          diffPreview: options.diffPreview ? truncateDiff(options.diffPreview) : undefined,
          linesAdded: options.linesAdded,
          linesRemoved: options.linesRemoved,
        };
      }
    }
  }

  /**
   * Record a file preview (dry-run mode - no actual changes made)
   * S2.1: Dry-run preview artifacts for observability
   */
  recordFilePreview(options: {
    path: string;
    sizeBytes?: number;
    preview?: string;
    linesAdded?: number;
    diffPreview?: string;
  }): void {
    void this.trace({
      eventType: 'file_created', // Use file_created event type for timeline consistency
      stepId: 'preview',
      title: `Preview: ${options.path}`,
      detail: { 
        path: options.path, 
        sizeBytes: options.sizeBytes,
        linesAdded: options.linesAdded,
        isDryRun: true,
      },
      status: 'success',
    });
    
    void this.recordArtifact({
      artifactType: 'file_preview',
      path: options.path,
      operation: 'preview',
      sizeBytes: options.sizeBytes,
      preview: options.preview,
      metadata: {
        isDryRun: true,
        linesAdded: options.linesAdded,
        diffPreview: options.diffPreview ? truncateDiff(options.diffPreview) : undefined,
      },
    });
  }

  /**
   * Flush all pending traces and artifacts to the database
   */
  async flush(): Promise<void> {
    const errors: Array<{ stage: string; error: unknown }> = [];

    // Insert traces
    if (this.pendingTraces.length > 0) {
      try {
        await db.insert(jobTraces).values(this.pendingTraces);
        this.pendingTraces = [];
      } catch (error) {
        errors.push({ stage: 'traces', error });
        logger.error(`[TraceRecorder] Failed to flush ${this.pendingTraces.length} traces for job ${this.jobId}: ${error}`);
      }
    }

    // Insert artifacts
    if (this.pendingArtifacts.length > 0) {
      try {
        await db.insert(jobArtifacts).values(this.pendingArtifacts);
        this.pendingArtifacts = [];
      } catch (error) {
        errors.push({ stage: 'artifacts', error });
        logger.error(`[TraceRecorder] Failed to flush ${this.pendingArtifacts.length} artifacts for job ${this.jobId}: ${error}`);
      }
    }

    // Insert AI call metrics (per-call breakdown)
    if (this.pendingAiCalls.length > 0) {
      try {
        await db.insert(jobAiCalls).values(this.pendingAiCalls);
        logger.debug(`[TraceRecorder] Flushed ${this.pendingAiCalls.length} AI call records for job ${this.jobId}`);
        this.pendingAiCalls = [];
      } catch (error) {
        errors.push({ stage: 'aiCalls', error });
        logger.error(`[TraceRecorder] Failed to flush ${this.pendingAiCalls.length} AI calls for job ${this.jobId}: ${error}`);
      }
    }

    // Propagate if any stage failed (caller decides whether to ignore)
    if (errors.length > 0) {
      const stages = errors.map(e => e.stage).join(', ');
      throw new Error(`TraceRecorder flush failed for stages: ${stages}`);
    }
  }

  /**
   * Get summary of recorded events (for job result)
   */
  getSummary(): { traceCount: number; artifactCount: number; documentsRead: number; filesProduced: number; filesPreview: number; aiCallCount: number } {
    const documentsRead = this.pendingArtifacts.filter(a => a.artifactType === 'doc_read').length;
    const filesProduced = this.pendingArtifacts.filter(a => 
      a.artifactType === 'file_created' || a.artifactType === 'file_modified'
    ).length;
    const filesPreview = this.pendingArtifacts.filter(a => a.artifactType === 'file_preview').length;
    
    return {
      traceCount: this.pendingTraces.length,
      artifactCount: this.pendingArtifacts.length,
      documentsRead,
      filesProduced,
      filesPreview,
      aiCallCount: this.pendingAiCalls.length,
    };
  }

  /**
   * Emit a stage change event to SSE stream
   * S2.0.3: Real-time stage updates
   */
  emitStage(
    stage: 'init' | 'planning' | 'executing' | 'reflecting' | 'validating' | 'publishing' | 'completed' | 'failed',
    status: 'started' | 'progress' | 'completed',
    message?: string
  ): void {
    if (!this.liveStreaming) return;
    jobEventBus.emitStage(this.jobId, stage, status, message);
  }

  /**
   * Emit a plan event to SSE stream
   * S2.0.3: Real-time plan updates
   */
  emitPlan(
    steps: Array<{ id: string; title: string; detail?: string }>,
    currentStepId?: string,
    planMarkdown?: string
  ): void {
    if (!this.liveStreaming) return;
    jobEventBus.emitPlan(this.jobId, steps, currentStepId, planMarkdown);
  }

  /**
   * Emit a log event to SSE stream
   */
  emitLog(level: 'info' | 'warn', message: string, detail?: Record<string, unknown>): void {
    if (!this.liveStreaming) return;
    jobEventBus.emitLog(this.jobId, level, message, detail);
  }

  /**
   * Emit an error event to SSE stream
   */
  emitError(
    message: string,
    scope: 'planning' | 'execution' | 'reflection' | 'validation' | 'mcp' | 'ai' | 'github' | 'unknown',
    fatal: boolean,
    code?: string
  ): void {
    if (!this.liveStreaming) return;
    jobEventBus.emitError(this.jobId, message, scope, fatal, code);
  }

  /**
   * Cleanup resources (call when job completes)
   */
  destroy(): void {
    if (this.batchFlushTimer) {
      clearInterval(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }
  }
}

/**
 * Create a TraceRecorder for a job
 * @param jobId - Job ID
 * @param options - TraceRecorder options (liveStreaming defaults to true)
 */
export function createTraceRecorder(jobId: string, options?: TraceRecorderOptions): TraceRecorder {
  return new TraceRecorder(jobId, options);
}
