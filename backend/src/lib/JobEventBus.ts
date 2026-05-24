import { EventEmitter } from 'events';
import type {
  StreamEvent,
  StageEvent,
  PlanEvent,
  ToolEvent,
  ArtifactEvent,
  LogEvent,
  ErrorEvent,
  TraceEvent,
  AiCallEvent,
} from '../types/stream-events.js';
import { formatSSEMessage, redactSensitiveText } from '../types/stream-events.js';

// Re-export stream event types for convenience
export type {
  StreamEvent,
  StageEvent,
  PlanEvent,
  ToolEvent,
  ArtifactEvent,
  LogEvent,
  ErrorEvent,
  TraceEvent,
  AiCallEvent,
};

// Legacy types for backward compatibility
export type JobPhase =
  | 'thinking'
  | 'discovery'
  | 'reading'
  | 'creating'
  | 'reviewing'
  | 'publishing'
  | 'done'
  | 'error';

export interface JobEvent {
  phase: JobPhase;
  message: string;
  ts: string;
  detail?: Record<string, unknown>;
}

const MAX_EVENTS_PER_JOB = 500; // Increased for more detailed traces
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Enhanced JobEventBus with support for both legacy phase events and new stream events
 * S2.0.3: Real-time execution trace support
 */
class JobEventBusImpl extends EventEmitter {
  private eventHistory: Map<string, JobEvent[]> = new Map();
  private streamEventHistory: Map<string, StreamEvent[]> = new Map();
  private eventCounters: Map<string, number> = new Map();
  private jobTimestamps: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.setMaxListeners(200);
    this.startCleanup();
  }

  /**
   * Get next event ID for a job (monotonically increasing)
   */
  private getNextEventId(jobId: string): number {
    const current = this.eventCounters.get(jobId) || 0;
    const next = current + 1;
    this.eventCounters.set(jobId, next);
    return next;
  }

  /**
   * Emit legacy phase event (backward compatibility)
   */
  emitJobEvent(jobId: string, event: JobEvent): void {
    if (!this.eventHistory.has(jobId)) {
      this.eventHistory.set(jobId, []);
    }
    const history = this.eventHistory.get(jobId)!;
    history.push(event);
    if (history.length > MAX_EVENTS_PER_JOB) {
      history.shift();
    }
    this.jobTimestamps.set(jobId, Date.now());
    this.emit(`job:${jobId}`, event);
  }

  /**
   * Create base event fields
   */
  private createBaseEvent(jobId: string): { eventId: number; ts: string; jobId: string } {
    return {
      eventId: this.getNextEventId(jobId),
      ts: new Date().toISOString(),
      jobId,
    };
  }

  /**
   * Store and emit a stream event
   */
  private storeAndEmit(jobId: string, event: StreamEvent): StreamEvent {
    if (!this.streamEventHistory.has(jobId)) {
      this.streamEventHistory.set(jobId, []);
    }
    const history = this.streamEventHistory.get(jobId)!;
    history.push(event);
    if (history.length > MAX_EVENTS_PER_JOB) {
      history.shift();
    }
    this.jobTimestamps.set(jobId, Date.now());
    this.emit(`stream:${jobId}`, event);
    return event;
  }

  /**
   * Emit stage change event
   */
  emitStage(
    jobId: string,
    stage: StageEvent['stage'],
    status: StageEvent['status'],
    message?: string
  ): StreamEvent {
    const event: StageEvent = {
      ...this.createBaseEvent(jobId),
      type: 'stage',
      stage,
      status,
      message,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit plan event
   */
  emitPlan(
    jobId: string,
    steps: PlanEvent['steps'],
    currentStepId?: string,
    planMarkdown?: string
  ): StreamEvent {
    const event: PlanEvent = {
      ...this.createBaseEvent(jobId),
      type: 'plan',
      steps,
      currentStepId,
      planMarkdown,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit tool call event
   */
  emitToolCall(
    jobId: string,
    opts: Omit<ToolEvent, 'type' | 'eventId' | 'ts' | 'jobId'>
  ): StreamEvent {
    const event: ToolEvent = {
      ...this.createBaseEvent(jobId),
      type: 'tool',
      toolName: opts.toolName,
      provider: opts.provider,
      inputSummary: opts.inputSummary ? redactSensitiveText(opts.inputSummary) : undefined,
      durationMs: opts.durationMs,
      ok: opts.ok,
      errorSummary: opts.errorSummary ? redactSensitiveText(opts.errorSummary) : undefined,
      correlationId: opts.correlationId,
      asked: opts.asked,
      did: opts.did,
      why: opts.why,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit artifact event
   */
  emitArtifact(
    jobId: string,
    opts: Omit<ArtifactEvent, 'type' | 'eventId' | 'ts' | 'jobId'>
  ): StreamEvent {
    const event: ArtifactEvent = {
      ...this.createBaseEvent(jobId),
      type: 'artifact',
      kind: opts.kind,
      label: opts.label,
      path: opts.path,
      url: opts.url,
      summary: opts.summary,
      preview: opts.preview ? redactSensitiveText(opts.preview) : undefined,
      operation: opts.operation,
      sizeBytes: opts.sizeBytes,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit log event
   */
  emitLog(
    jobId: string,
    level: LogEvent['level'],
    message: string,
    detail?: Record<string, unknown>
  ): StreamEvent {
    const event: LogEvent = {
      ...this.createBaseEvent(jobId),
      type: 'log',
      level,
      message: redactSensitiveText(message),
      detail,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit error event
   */
  emitError(
    jobId: string,
    message: string,
    scope: ErrorEvent['scope'],
    fatal: boolean,
    code?: string
  ): StreamEvent {
    const event: ErrorEvent = {
      ...this.createBaseEvent(jobId),
      type: 'error',
      message: redactSensitiveText(message),
      scope,
      fatal,
      code,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit trace event (detailed timeline entry)
   */
  emitTrace(
    jobId: string,
    opts: Omit<TraceEvent, 'type' | 'eventId' | 'ts' | 'jobId'>
  ): StreamEvent {
    const event: TraceEvent = {
      ...this.createBaseEvent(jobId),
      type: 'trace',
      eventType: opts.eventType,
      stepId: opts.stepId,
      title: redactSensitiveText(opts.title),
      detail: opts.detail,
      durationMs: opts.durationMs,
      status: opts.status,
      correlationId: opts.correlationId,
      toolName: opts.toolName,
      inputSummary: opts.inputSummary ? redactSensitiveText(opts.inputSummary) : undefined,
      outputSummary: opts.outputSummary ? redactSensitiveText(opts.outputSummary) : undefined,
      reasoningSummary: opts.reasoningSummary,
      askedWhat: opts.askedWhat,
      didWhat: opts.didWhat,
      whyReason: opts.whyReason,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Emit AI call event
   */
  emitAiCall(
    jobId: string,
    opts: Omit<AiCallEvent, 'type' | 'eventId' | 'ts' | 'jobId'>
  ): StreamEvent {
    const event: AiCallEvent = {
      ...this.createBaseEvent(jobId),
      type: 'ai_call',
      purpose: opts.purpose,
      provider: opts.provider,
      model: opts.model,
      durationMs: opts.durationMs,
      tokens: opts.tokens,
      ok: opts.ok,
      errorCode: opts.errorCode,
    };
    return this.storeAndEmit(jobId, event);
  }

  /**
   * Subscribe to legacy phase events
   */
  subscribe(jobId: string, callback: (event: JobEvent) => void): void {
    this.on(`job:${jobId}`, callback);
  }

  /**
   * Unsubscribe from legacy phase events
   */
  unsubscribe(jobId: string, callback: (event: JobEvent) => void): void {
    this.off(`job:${jobId}`, callback);
  }

  /**
   * Subscribe to stream events
   */
  subscribeStream(jobId: string, callback: (event: StreamEvent) => void): void {
    this.on(`stream:${jobId}`, callback);
  }

  /**
   * Unsubscribe from stream events
   */
  unsubscribeStream(jobId: string, callback: (event: StreamEvent) => void): void {
    this.off(`stream:${jobId}`, callback);
  }

  /**
   * Get legacy event history
   */
  getHistory(jobId: string): JobEvent[] {
    return this.eventHistory.get(jobId) || [];
  }

  /**
   * Get stream event history
   */
  getStreamHistory(jobId: string): StreamEvent[] {
    return this.streamEventHistory.get(jobId) || [];
  }

  /**
   * Get stream events after a specific event ID (for reconnection)
   */
  getStreamHistoryAfter(jobId: string, afterEventId: number): StreamEvent[] {
    const history = this.streamEventHistory.get(jobId) || [];
    return history.filter((e) => e.eventId > afterEventId);
  }

  /**
   * Get current event counter for a job
   */
  getCurrentEventId(jobId: string): number {
    return this.eventCounters.get(jobId) || 0;
  }

  /**
   * Format event for SSE
   */
  formatForSSE(event: StreamEvent): string {
    return formatSSEMessage(event);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [jobId, timestamp] of this.jobTimestamps) {
        if (now - timestamp > CLEANUP_INTERVAL_MS) {
          this.eventHistory.delete(jobId);
          this.streamEventHistory.delete(jobId);
          this.eventCounters.delete(jobId);
          this.jobTimestamps.delete(jobId);
          this.removeAllListeners(`job:${jobId}`);
          this.removeAllListeners(`stream:${jobId}`);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.eventHistory.clear();
    this.streamEventHistory.clear();
    this.eventCounters.clear();
    this.jobTimestamps.clear();
    this.removeAllListeners();
  }
}

export const jobEventBus = new JobEventBusImpl();
