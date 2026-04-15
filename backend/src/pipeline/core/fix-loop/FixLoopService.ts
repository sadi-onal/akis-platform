import type { StructuredSpec } from '../contracts/PipelineTypes.js';
import type {
  FixLoopConfig,
  FixLoopIteration,
  FixLoopResult,
  RunProtoFn,
  RunTraceFn,
} from './FixLoopTypes.js';
import { DEFAULT_FIX_LOOP_CONFIG } from './FixLoopTypes.js';

// ─── Timeout Helper ──────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Fix-loop iteration timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// ─── Helpers ─────────────────────────────────────

/**
 * Determine whether the Trace output represents passing tests.
 * Trace.ok === true AND every acceptance criterion is covered.
 */
function didTestsPass(traceOutput: { ok: boolean; testSummary: { uncoveredCriteria: string[] } }): boolean {
  return traceOutput.ok && traceOutput.testSummary.uncoveredCriteria.length === 0;
}

/**
 * Build a concise failure summary from Trace output to feed back to Proto.
 */
function buildFailureSummary(traceOutput: {
  ok: boolean;
  testSummary: { totalTests: number; coveragePercentage: number; uncoveredCriteria: string[] };
}): string {
  const parts: string[] = [];
  if (!traceOutput.ok) {
    parts.push('Trace reported failure (ok=false).');
  }
  const { totalTests, coveragePercentage, uncoveredCriteria } = traceOutput.testSummary;
  parts.push(`Tests: ${totalTests}, Coverage: ${coveragePercentage}%.`);
  if (uncoveredCriteria.length > 0) {
    parts.push(`Uncovered criteria: ${uncoveredCriteria.join(', ')}.`);
  }
  return parts.join(' ');
}

// ─── FixLoopService ──────────────────────────────

export class FixLoopService {
  private config: FixLoopConfig;

  constructor(config?: Partial<FixLoopConfig>) {
    this.config = { ...DEFAULT_FIX_LOOP_CONFIG, ...config };
  }

  /**
   * Run the self-healing Proto+Trace loop.
   *
   * @param spec       - The approved StructuredSpec
   * @param runProto   - Callback that runs Proto (injected by orchestrator)
   * @param runTrace   - Callback that runs Trace (injected by orchestrator)
   * @returns          - FixLoopResult with iteration details
   */
  async runFixLoop(
    spec: StructuredSpec,
    runProto: RunProtoFn,
    runTrace: RunTraceFn,
  ): Promise<FixLoopResult> {
    const iterations: FixLoopIteration[] = [];
    let previousFailure: string | undefined;

    for (let i = 0; i < this.config.maxIterations; i++) {
      const temperature = this.config.baseTemperature + i * this.config.temperatureIncrement;
      const iterationStart = Date.now();

      try {
        // --- Run Proto (with timeout) ---
        const feedback = i === 0 ? undefined : previousFailure;
        const protoOutput = await withTimeout(
          runProto(spec, feedback, temperature),
          this.config.timeoutPerIteration,
        );

        // --- Run Trace (with timeout, sharing the remaining budget) ---
        const elapsed = Date.now() - iterationStart;
        const remainingMs = Math.max(this.config.timeoutPerIteration - elapsed, 1000);
        const traceOutput = await withTimeout(
          runTrace(protoOutput),
          remainingMs,
        );

        // --- Evaluate ---
        const passed = didTestsPass(traceOutput);
        const failureReason = passed ? undefined : buildFailureSummary(traceOutput);

        const iteration: FixLoopIteration = {
          iteration: i,
          temperature: Math.round(temperature * 100) / 100, // avoid float drift
          protoOutput,
          traceOutput,
          testsPassed: passed,
          failureReason,
          durationMs: Date.now() - iterationStart,
        };
        iterations.push(iteration);

        if (passed) {
          return {
            success: true,
            totalIterations: iterations.length,
            iterations,
            finalProtoOutput: protoOutput,
            finalTraceOutput: traceOutput,
            terminationReason: 'tests_passed',
          };
        }

        // Store failure for next iteration's feedback
        previousFailure = failureReason;
      } catch (err) {
        const isTimeout = err instanceof Error && err.message.includes('timed out');
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Record partial iteration (no trace/proto output on hard error)
        // We only record if we have at least partial data
        const partialIteration: FixLoopIteration = {
          iteration: i,
          temperature: Math.round(temperature * 100) / 100,
          protoOutput: { ok: false, branch: '', repo: '', repoUrl: '', files: [], setupCommands: [], metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: '', committed: false } },
          traceOutput: { ok: false, testFiles: [], coverageMatrix: {}, testSummary: { totalTests: 0, coveragePercentage: 0, coveredCriteria: [], uncoveredCriteria: [] } },
          testsPassed: false,
          failureReason: errorMessage,
          durationMs: Date.now() - iterationStart,
        };
        iterations.push(partialIteration);

        return {
          success: false,
          totalIterations: iterations.length,
          iterations,
          terminationReason: isTimeout ? 'timeout' : 'error',
          errorMessage,
        };
      }
    }

    // All iterations exhausted without passing
    return {
      success: false,
      totalIterations: iterations.length,
      iterations,
      terminationReason: 'max_iterations',
    };
  }
}
