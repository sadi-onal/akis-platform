/**
 * Reasoning / explainability helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 */
import type { ProtoOutput, ScribeOutput, TraceOutput } from '../../contracts/PipelineTypes.js';
import type { AgentReasoning } from '../../explainability/ExplainabilityTypes.js';
import type { ExplainabilityService } from '../../explainability/ExplainabilityService.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import {
  buildScribeReasoning,
  buildProtoReasoning,
  buildTraceReasoning,
} from '../../explainability/reasoningFactory.js';
import { buildAcCoverage } from '../../explainability/acCoverage.js';
import { injectArtifacts } from '../../../agents/proto/artifactInjector.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Persist a reasoning entry without blocking the caller.
 *
 * Three retries with exponential backoff (50/200/600ms) cover common
 * transient cases before falling back to logging + flagging the pipeline
 * as "explainability degraded".
 */
export function persistReasoning(
  pipelineId: string,
  reasoning: AgentReasoning,
  explainability: ExplainabilityService,
  store: PipelineStore
): void {
  const attempt = async (n: number): Promise<void> => {
    try {
      await explainability.addReasoning(pipelineId, reasoning);
    } catch (err) {
      if (n < 3) {
        const delay = 50 * 4 ** n; // 50, 200, 800 -- caps under 1s for the 3rd retry
        await new Promise((r) => setTimeout(r, delay));
        return attempt(n + 1);
      }
      logger.warn(
        { err, pipelineId, agent: reasoning.agentName, retries: n },
        '[Pipeline] PR-U3 M7: failed to persist reasoning after retries; flagging pipeline as explainability-degraded'
      );
      try {
        const pipeline = await store.getById(pipelineId);
        const intermediate = (pipeline?.intermediateState ?? {}) as Record<string, unknown>;
        await store.update(pipelineId, {
          intermediateState: {
            ...intermediate,
            explainabilityDegraded: true,
            explainabilityDegradedAt: new Date().toISOString(),
          },
        });
      } catch (flagErr) {
        logger.warn(
          { flagErr, pipelineId },
          '[Pipeline] PR-U3 M7: also failed to set explainabilityDegraded flag — UI will see empty Açıklama'
        );
      }
    }
  };
  void attempt(0);
}

/** Level 4: Explainability -- Scribe reasoning after spec generation. */
export function recordScribeReasoning(
  pipelineId: string,
  output: ScribeOutput,
  regenerated: boolean,
  explainability: ExplainabilityService,
  store: PipelineStore
): void {
  persistReasoning(
    pipelineId,
    buildScribeReasoning(output, { regenerated }),
    explainability,
    store
  );
}

/** Level 4: Explainability -- Proto reasoning after scaffold push. */
export function recordProtoReasoning(
  pipelineId: string,
  output: ProtoOutput,
  explainability: ExplainabilityService,
  store: PipelineStore,
  scribeOutput?: ScribeOutput
): void {
  persistReasoning(
    pipelineId,
    buildProtoReasoning(output, { scribeOutput }),
    explainability,
    store
  );
}

/** Level 4: Explainability -- Trace reasoning after test generation. */
export function recordTraceReasoning(
  pipelineId: string,
  output: TraceOutput,
  explainability: ExplainabilityService,
  store: PipelineStore
): void {
  persistReasoning(pipelineId, buildTraceReasoning(output), explainability, store);
}

/**
 * Compute AC coverage report from pipeline outputs and merge it into
 * `intermediateState.acCoverage`. Best-effort -- persistence failures
 * are swallowed with a warning.
 */
export async function persistAcCoverage(
  pipelineId: string,
  protoOutput: ProtoOutput,
  scribeOutput: ScribeOutput | undefined,
  store: PipelineStore,
  traceOutput?: TraceOutput
): Promise<void> {
  try {
    const report = buildAcCoverage(scribeOutput, protoOutput, traceOutput);
    if (report.totalAcs === 0) return;
    const current = await store.getById(pipelineId);
    const existing = (current?.intermediateState ?? {}) as Record<string, unknown>;
    await store.update(pipelineId, {
      intermediateState: { ...existing, acCoverage: report },
    });
  } catch (err) {
    logger.warn({ err, pipelineId }, '[Pipeline] Failed to persist acCoverage');
  }
}

/**
 * Inject `docs/PRD.md`, `docs/TECHNICAL-ANALYSIS.md`, and optionally
 * `docs/API-CONTRACT.md` into Proto's file set. Idempotent and non-fatal.
 */
export function applyArtifactInjection(
  protoOutput: ProtoOutput,
  scribeOutput?: ScribeOutput
): ProtoOutput {
  try {
    const result = injectArtifacts({
      files: protoOutput.files,
      scribeOutput,
    });
    if (result.added.length === 0) return protoOutput;
    const totalLOC = result.files.reduce((sum, f) => sum + (f.linesOfCode ?? 0), 0);
    return {
      ...protoOutput,
      files: result.files,
      metadata: {
        ...protoOutput.metadata,
        filesCreated: result.files.length,
        totalLinesOfCode: totalLOC,
      },
    };
  } catch (err) {
    logger.warn({ err }, '[Pipeline] applyArtifactInjection failed -- using original files');
    return protoOutput;
  }
}
