import { EventEmitter } from 'events';

// Pipeline-level in-memory event bus for real-time activity tracking
export const pipelineBus = new EventEmitter();
pipelineBus.setMaxListeners(50);

export interface PipelineActivity {
  pipelineId: string;
  /**
   * Originating stage. `critic` and `fix-loop` were added when the pipeline
   * grew explicit adversarial review and self-repair phases — older clients
   * that only know `scribe|proto|trace` should treat unknown values as
   * pass-through cosmetic events rather than crashing.
   */
  stage: 'scribe' | 'proto' | 'trace' | 'critic' | 'fix-loop';
  step: string;
  message: string;
  detail?: string;
  progress?: number; // 0-100
  retryCount?: number; // >0 when agent is retrying a transient failure
  /**
   * Stable i18n key for the activity message (e.g. `pipeline.activity.proto.writing_files`).
   * Frontend prefers this over `message` when present so the same backend event
   * renders in the user's chosen locale. `message` stays as the Turkish fallback.
   */
  activityKey?: string;
  /**
   * Optional reasoning snippet attached for "cinema" / explainability
   * surfaces. Compact subset of AgentReasoning so the SSE payload stays
   * small; the full reasoning record is still queryable via
   * GET /pipelines/:id/explanation.
   */
  reasoning?: {
    decision: string;
    snippet?: string;
    confidence?: number; // 0-100
  };
  timestamp: string;
}

// Ring buffer of recent activities per pipeline — used by the replay endpoint
// so a client reconnecting mid-pipeline can reconstruct progress state without
// waiting for the next live emit.
const ACTIVITY_BUFFER_LIMIT = 50;
const activityBuffers = new Map<string, PipelineActivity[]>();

export function emitActivity(activity: PipelineActivity): void {
  const buf = activityBuffers.get(activity.pipelineId) ?? [];
  buf.push(activity);
  if (buf.length > ACTIVITY_BUFFER_LIMIT) buf.shift();
  activityBuffers.set(activity.pipelineId, buf);
  pipelineBus.emit(`pipeline:${activity.pipelineId}`, activity);
}

export function getActivities(pipelineId: string): PipelineActivity[] {
  return activityBuffers.get(pipelineId) ?? [];
}

/** Remove all listeners and drop buffered activities for a terminal pipeline. */
export function cleanupPipelineListeners(pipelineId: string): void {
  pipelineBus.removeAllListeners(`pipeline:${pipelineId}`);
  // Defer buffer cleanup so a client returning right after completion can
  // still fetch the final state; 5 min is enough to cover typical reloads.
  setTimeout(() => activityBuffers.delete(pipelineId), 5 * 60 * 1000).unref();
}

export function createActivityEmitter(pipelineId: string, stage: PipelineActivity['stage']) {
  return (
    step: string,
    message: string,
    progress?: number,
    detail?: string,
    retryCount?: number,
    activityKey?: string,
    reasoning?: PipelineActivity['reasoning']
  ) => {
    emitActivity({
      pipelineId,
      stage,
      step,
      message,
      progress,
      detail,
      retryCount,
      ...(activityKey ? { activityKey } : {}),
      ...(reasoning ? { reasoning } : {}),
      timestamp: new Date().toISOString(),
    });
  };
}
