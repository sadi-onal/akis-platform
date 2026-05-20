import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * T1: per-async-execution pipelineId context for AI call logging.
 *
 * The PipelineOrchestrator wraps each background run (`runScribeAnalysis`,
 * `runProtoAndTrace`, `runTrace`, `runCriticSpecReview`, etc.) in
 * `pipelineCallContext.run({ pipelineId }, ...)`. Anything awaited inside —
 * including `aiService.complete(...)` deep in an agent — can then read the
 * pipelineId out of ALS without threading it through every signature.
 *
 * The `PipelineAiCallRecorder` observer reads it to attach `pipeline_id`
 * to each `job_ai_calls` insert. When the context is absent (legacy
 * single-agent path, smoke scripts, tests), the observer silently no-ops so
 * the existing TraceRecorder write path stays the only writer for those.
 */
interface PipelineCallStore {
  pipelineId: string;
}

export const pipelineCallContext = new AsyncLocalStorage<PipelineCallStore>();

export function runWithPipelineContext<T>(pipelineId: string, fn: () => Promise<T>): Promise<T> {
  return pipelineCallContext.run({ pipelineId }, fn);
}

export function getCurrentPipelineId(): string | null {
  return pipelineCallContext.getStore()?.pipelineId ?? null;
}
