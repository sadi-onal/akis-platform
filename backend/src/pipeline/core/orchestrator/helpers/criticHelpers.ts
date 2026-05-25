/**
 * Critic review helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 */
import type { StructuredSpec, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';
import type { CriticAgent, CriticResult } from '../../../agents/critic/CriticAgent.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Run CriticAgent spec review. Returns the review output or null on error.
 * Errors are logged but do not fail the pipeline -- critic is advisory.
 */
export async function runCriticSpecReview(
  pipelineId: string,
  spec: StructuredSpec,
  originalIdea: string,
  criticAgent: CriticAgent | undefined
): Promise<CriticReviewOutput | null> {
  if (!criticAgent) return null;
  try {
    const result: CriticResult = await criticAgent.reviewSpec(
      { reviewType: 'spec_review', artifact: spec, originalIdea },
      1
    );
    if (result.type === 'review') return result.data;
    logger.warn(
      { pipelineId, error: result.error },
      '[Pipeline] Critic spec review returned error'
    );
    return null;
  } catch (err) {
    logger.warn({ err, pipelineId }, '[Pipeline] Critic spec review failed (non-fatal)');
    return null;
  }
}

/**
 * Run CriticAgent code review. Returns the review output or null on error.
 * Errors are logged but do not fail the pipeline -- critic is advisory.
 */
export async function runCriticCodeReview(
  pipelineId: string,
  protoOutput: ProtoOutput,
  spec: StructuredSpec,
  originalIdea: string,
  criticAgent: CriticAgent | undefined
): Promise<CriticReviewOutput | null> {
  if (!criticAgent) return null;
  try {
    const result: CriticResult = await criticAgent.reviewCode(
      { reviewType: 'code_review', artifact: protoOutput, originalIdea, referenceSpec: spec },
      1
    );
    if (result.type === 'review') return result.data;
    logger.warn(
      { pipelineId, error: result.error },
      '[Pipeline] Critic code review returned error'
    );
    return null;
  } catch (err) {
    logger.warn({ err, pipelineId }, '[Pipeline] Critic code review failed (non-fatal)');
    return null;
  }
}

/**
 * Evaluate whether the Trace iterate-loop should re-iterate Proto.
 *
 * Rules:
 *   - traceEnabled === false => iterate loop disabled.
 *   - uncoveredCriteria.length === 0 && ok !== false => no iterate.
 *   - retry count >= max => stop iterating, hand off to push gate.
 *   - Otherwise: produce feedback text, increment retry, shouldIterate=true.
 */
export async function evaluateTraceIterateLoop(
  pipelineId: string,
  traceOutput: TraceOutput,
  store: PipelineStore,
  spec?: StructuredSpec
): Promise<{
  shouldIterate: boolean;
  nextRetry: number;
  maxRetries: number;
  uncoveredCount: number;
  totalCount: number;
  feedback: string;
}> {
  const maxRetriesRaw = parseInt(process.env.TRACE_MAX_ITERATE_RETRIES ?? '3', 10);
  const maxRetries = Number.isFinite(maxRetriesRaw) ? Math.max(0, Math.min(10, maxRetriesRaw)) : 3;

  const pipeline = await store.getById(pipelineId);
  const noopResult = {
    shouldIterate: false,
    nextRetry: 0,
    maxRetries,
    uncoveredCount: 0,
    totalCount: 0,
    feedback: '',
  };
  if (!pipeline) return noopResult;
  if (pipeline.traceEnabled === false) return noopResult;

  const uncovered = traceOutput.testSummary?.uncoveredCriteria ?? [];
  const covered = traceOutput.testSummary?.coveredCriteria ?? [];
  const uncoveredCount = uncovered.length;
  const traceOk = traceOutput.ok !== false;
  if (uncoveredCount === 0 && traceOk) return noopResult;

  const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
  const currentRetry =
    typeof intermediate.traceIterateRetryCount === 'number'
      ? (intermediate.traceIterateRetryCount as number)
      : 0;
  const totalCount = uncovered.length + covered.length;
  if (currentRetry >= maxRetries) {
    logger.info(
      { pipelineId, currentRetry, maxRetries, uncoveredCount },
      '[Pipeline] PR-F Trace iterate-loop max retries reached — handing off to push gate'
    );
    return { ...noopResult, uncoveredCount, totalCount };
  }

  const nextRetry = currentRetry + 1;
  const acDetails =
    spec?.acceptanceCriteria
      ?.filter((ac) => uncovered.includes(ac.id))
      .map((ac) => `- ${ac.id}: ${ac.given} → ${ac.when} → ${ac.then}`) ?? [];
  const feedbackLines = [
    'Trace tamamlandı ama bazı kabul kriterleri test edilmedi.',
    '',
    `Eksik kabul kriterleri (${uncoveredCount}/${totalCount}):`,
    ...(acDetails.length > 0 ? acDetails : uncovered.map((id) => `- ${id}`)),
    '',
    'Bu kabul kriterlerini karşılayan ek kod üretmeni veya mevcut kodu güncellemeni istiyorum.',
  ];
  if (!traceOk) {
    feedbackLines.splice(1, 0, 'Bazı testler başarısız oldu, davranışı düzeltmeni istiyorum.');
  }
  const feedback = feedbackLines.join('\n');
  return {
    shouldIterate: true,
    nextRetry,
    maxRetries,
    uncoveredCount,
    totalCount,
    feedback,
  };
}

/**
 * Evaluate whether the Critic iterate-loop should re-iterate Proto
 * based on critical findings.
 *
 * Rules:
 *   - No critical findings => no iterate.
 *   - retry count >= max => stop, fall back to awaiting_critic_resolution.
 *   - Otherwise: produce feedback from critical findings, shouldIterate=true.
 */
export async function evaluateCriticIterateLoop(
  pipelineId: string,
  criticResult: CriticReviewOutput,
  store: PipelineStore,
  spec?: StructuredSpec
): Promise<{
  shouldIterate: boolean;
  nextRetry: number;
  maxRetries: number;
  criticalCount: number;
  feedback: string;
}> {
  const maxRetriesRaw = parseInt(process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES ?? '3', 10);
  const maxRetries = Number.isFinite(maxRetriesRaw) ? Math.max(0, Math.min(10, maxRetriesRaw)) : 3;

  const pipeline = await store.getById(pipelineId);
  const noopResult = {
    shouldIterate: false,
    nextRetry: 0,
    maxRetries,
    criticalCount: 0,
    feedback: '',
  };
  if (!pipeline) return noopResult;

  const criticalFindings = (criticResult.findings ?? []).filter((f) => f.severity === 'critical');
  if (criticalFindings.length === 0) return noopResult;

  const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
  const currentRetry =
    typeof intermediate.criticIterateRetryCount === 'number'
      ? (intermediate.criticIterateRetryCount as number)
      : 0;

  if (currentRetry >= maxRetries) {
    logger.info(
      {
        pipelineId,
        currentRetry,
        maxRetries,
        criticalCount: criticalFindings.length,
      },
      '[Pipeline] PR-F3 Critic iterate-loop max retries reached — handing off to awaiting_critic_resolution'
    );
    return { ...noopResult, criticalCount: criticalFindings.length };
  }

  const nextRetry = currentRetry + 1;
  const feedbackLines = [
    'Aşağıdaki kritik bulgular önceki Proto çıktısında tespit edildi. Kodu bu doğrultuda düzelt:',
    '',
    ...criticalFindings.map(
      (f, idx) =>
        `${idx + 1}. ${f.description}\n   Öneri: ${f.suggestion}${f.location ? `\n   Konum: ${f.location}` : ''}`
    ),
  ];
  // Append AC context from spec so Proto knows which acceptance criteria to satisfy
  const acList = spec?.acceptanceCriteria;
  if (acList && acList.length > 0) {
    feedbackLines.push(
      '',
      'İlgili kabul kriterleri (spec\'ten):',
      ...acList.map((ac) => `- ${ac.id}: ${ac.given} → ${ac.when} → ${ac.then}`),
    );
  }
  feedbackLines.push(
    '',
    'Lütfen yukarıdaki bulguları VE listelenen kabul kriterlerini karşılayan kodu üret.',
  );
  const feedback = feedbackLines.join('\n');
  return {
    shouldIterate: true,
    nextRetry,
    maxRetries,
    criticalCount: criticalFindings.length,
    feedback,
  };
}
