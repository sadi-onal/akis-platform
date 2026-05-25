/**
 * Activity/chat-event helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 * Store, getPipeline, and timing helpers are passed as explicit parameters.
 */
import type {
  PipelineState,
  ScribeMessageType,
  ScribeOutput,
  ProtoOutput,
  SubStep,
} from '../../contracts/PipelineTypes.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import { emitActivity } from '../../activityEmitter.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';

// ── Pure functions ───────────────────────────────────────────

/** Count how many events of a given type have been appended to a conversation. */
export function countPriorEvents(
  conv: ScribeMessageType[],
  type: 'proto_completed' | 'trace_completed' | 'scribe_completed'
): number {
  return conv.filter((m) => m.type === type).length;
}

/**
 * Build SubStep list for a completion event. Reads pipeline outputs +
 * intermediateState and translates them into human-language sub-step rows.
 * Returns an empty array when the stage has no inputs yet.
 */
export function buildSubStepsForStage(
  pipeline: PipelineState,
  stage: 'scribe' | 'proto' | 'trace'
): SubStep[] {
  const steps: SubStep[] = [];

  if (stage === 'scribe') {
    if (pipeline.scribeOutput) {
      const storyCount = pipeline.scribeOutput.spec.userStories?.length ?? 0;
      const acCount = pipeline.scribeOutput.spec.acceptanceCriteria?.length ?? 0;
      steps.push({
        label: `${storyCount} user story çıkarıldı`,
        status: 'done',
        source: 'agent',
      });
      steps.push({
        label: `${acCount} kabul kriteri yazıldı`,
        status: 'done',
        source: 'agent',
      });
    }
    const criticSpecOutput = pipeline.intermediateState?.criticSpecOutput as
      | CriticReviewOutput
      | undefined;
    if (criticSpecOutput && (criticSpecOutput.findings?.length ?? 0) > 0) {
      steps.push({
        label: `Değerlendirme: ${criticSpecOutput.findings.length} eksik nokta tespit edildi`,
        status: 'done',
        source: 'critic',
      });
    }
  }

  if (stage === 'proto') {
    if (pipeline.protoOutput) {
      steps.push({
        label: 'Proje iskeleti üretildi',
        status: 'done',
        source: 'agent',
      });
      steps.push({
        label: `${pipeline.protoOutput.files.length} dosya yazıldı`,
        status: 'done',
        source: 'agent',
      });
    }
    const validatorResult = pipeline.intermediateState?.validationResult as
      | { passed?: boolean; summary?: { errors?: number; warnings?: number } }
      | undefined;
    if (validatorResult) {
      const errorCount = validatorResult.summary?.errors ?? 0;
      steps.push({
        label:
          errorCount === 0
            ? 'Statik kontrol: temiz'
            : `Statik kontrol: ${errorCount} hata raporlandı`,
        status: 'done',
        source: 'validator',
      });
    }
    const criticCodeOutput = pipeline.intermediateState?.criticCodeOutput as
      | CriticReviewOutput
      | undefined;
    if (criticCodeOutput && (criticCodeOutput.findings?.length ?? 0) > 0) {
      steps.push({
        label: `Değerlendirme: ${criticCodeOutput.findings.length} öneri uygulandı`,
        status: 'done',
        source: 'critic',
      });
    }
  }

  if (stage === 'trace') {
    if (pipeline.traceOutput) {
      steps.push({
        label: `${pipeline.traceOutput.testSummary?.totalTests ?? 0} test senaryosu yazıldı`,
        status: 'done',
        source: 'agent',
      });
      if (pipeline.traceOutput.testSummary?.coveragePercentage !== undefined) {
        steps.push({
          label: `%${pipeline.traceOutput.testSummary.coveragePercentage} kapsam doğrulandı`,
          status: 'done',
          source: 'agent',
        });
      }
    }
  }

  return steps;
}

/**
 * Builds a `scribe_completed` event in memory without persisting.
 * Mirrors `appendScribeCompleted` semantics.
 */
export function buildScribeCompletedEvent(
  _pipelineId: string,
  iteration: number,
  output: ScribeOutput,
  durationMs: number | undefined,
  subSteps?: SubStep[]
): Extract<ScribeMessageType, { type: 'scribe_completed' }> {
  return {
    type: 'scribe_completed',
    content: {
      iteration,
      summary: output.summary ?? 'Plan hazırlandı.',
      storyCount: output.spec.userStories?.length ?? 0,
      acCount: output.spec.acceptanceCriteria?.length ?? 0,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

// ── Functions with store dependencies ────────────────────────

/** Emit the `stage_completed` SSE activity for the outgoing stage. */
export function emitStageCompleted(
  pipelineId: string,
  stage: 'scribe' | 'proto' | 'trace',
  summary?: string
): void {
  emitActivity({
    pipelineId,
    stage,
    step: 'stage_completed',
    message: summary ?? `${stage} aşaması tamamlandı`,
    progress: 100,
    status: 'completed',
    timestamp: new Date().toISOString(),
  });
}

/** Append a `proto_started` event to the conversation and return the iteration number. */
export async function appendProtoStarted(
  pipelineId: string,
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  markStageStartedFn: (pipelineId: string, stage: 'scribe' | 'proto' | 'trace') => number
): Promise<number> {
  const pipeline = await getPipelineFn(pipelineId);
  const iteration = countPriorEvents(pipeline.scribeConversation, 'proto_completed') + 1;
  markStageStartedFn(pipelineId, 'proto');
  await store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      { type: 'proto_started', content: { iteration }, timestamp: new Date().toISOString() },
    ],
  });
  return iteration;
}

/** Append a `proto_completed` event to the conversation. */
export async function appendProtoCompleted(
  pipelineId: string,
  iteration: number,
  output: ProtoOutput,
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  getStageDurationMsFn: (
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace'
  ) => number | undefined,
  subSteps?: SubStep[]
): Promise<void> {
  const pipeline = await getPipelineFn(pipelineId);
  const durationMs = getStageDurationMsFn(pipelineId, 'proto');
  await store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'proto_completed',
        content: {
          iteration,
          summary: output.summary ?? 'Proje dosyaları hazır.',
          filesCreated: output.metadata.filesCreated,
          totalLines: output.metadata.totalLinesOfCode,
          branch: output.branch,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/**
 * Emit the `proto_completed` chat event for the current Proto iteration.
 * Must run AFTER both the Validator step and the Critic-code review have
 * written their results to `intermediateState`.
 */
export async function emitProtoCompletedForIteration(
  pipelineId: string,
  iteration: number,
  output: ProtoOutput,
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  getStageDurationMsFn: (
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace'
  ) => number | undefined
): Promise<void> {
  const pipelineSnapshot = await getPipelineFn(pipelineId);
  const subSteps = buildSubStepsForStage(
    { ...pipelineSnapshot, protoOutput: output } as PipelineState,
    'proto'
  );
  await appendProtoCompleted(
    pipelineId,
    iteration,
    output,
    store,
    getPipelineFn,
    getStageDurationMsFn,
    subSteps.length > 0 ? subSteps : undefined
  );
}

/** Append a `trace_started` event to the conversation and return the iteration number. */
export async function appendTraceStarted(
  pipelineId: string,
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  markStageStartedFn: (pipelineId: string, stage: 'scribe' | 'proto' | 'trace') => number
): Promise<number> {
  const pipeline = await getPipelineFn(pipelineId);
  const iteration = countPriorEvents(pipeline.scribeConversation, 'trace_completed') + 1;
  markStageStartedFn(pipelineId, 'trace');
  await store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'trace_started',
        content: { iteration },
        timestamp: new Date().toISOString(),
      },
    ],
  });
  return iteration;
}

/** Append a `trace_completed` event to the conversation. */
export async function appendTraceCompleted(
  pipelineId: string,
  iteration: number,
  output: {
    testSummary: { totalTests: number; coveragePercentage: number };
    summary?: string;
  },
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  getStageDurationMsFn: (
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace'
  ) => number | undefined,
  subSteps?: SubStep[]
): Promise<void> {
  const pipeline = await getPipelineFn(pipelineId);
  const durationMs = getStageDurationMsFn(pipelineId, 'trace');
  await store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'trace_completed',
        content: {
          iteration,
          totalTests: output.testSummary.totalTests,
          coverage: output.testSummary.coveragePercentage,
          passed: true,
          ...(output.summary ? { summary: output.summary } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/** Append a `trace_failed` event to the conversation. */
export async function appendTraceFailed(
  pipelineId: string,
  iteration: number,
  errorCode: string,
  errorMessage: string,
  store: PipelineStore,
  getPipelineFn: (id: string) => Promise<PipelineState>,
  recoveryAction?: 'retry' | 'skip'
): Promise<void> {
  const pipeline = await getPipelineFn(pipelineId);
  await store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'trace_failed',
        content: { iteration, errorCode, errorMessage, recoveryAction },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
