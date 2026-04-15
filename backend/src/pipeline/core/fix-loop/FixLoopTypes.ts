import type { StructuredSpec, ProtoOutput, TraceOutput } from '../contracts/PipelineTypes.js';

// ─── Configuration ───────────────────────────────

export interface FixLoopConfig {
  /** Maximum number of Proto+Trace iterations before giving up. Default: 3 */
  maxIterations: number;
  /** Starting temperature for the first iteration. Default: 0 */
  baseTemperature: number;
  /** Temperature increase per iteration. Default: 0.1 */
  temperatureIncrement: number;
  /** Timeout per single iteration (ms). Default: 5 * 60 * 1000 (5 min) */
  timeoutPerIteration: number;
}

export const DEFAULT_FIX_LOOP_CONFIG: FixLoopConfig = {
  maxIterations: 3,
  baseTemperature: 0,
  temperatureIncrement: 0.1,
  timeoutPerIteration: 5 * 60 * 1000,
};

// ─── Iteration Record ────────────────────────────

export interface FixLoopIteration {
  /** 0-indexed iteration number */
  iteration: number;
  /** Temperature used for this iteration */
  temperature: number;
  /** Proto output from this iteration */
  protoOutput: ProtoOutput;
  /** Trace output from this iteration */
  traceOutput: TraceOutput;
  /** Whether all tests passed in this iteration */
  testsPassed: boolean;
  /** Failure summary when tests did not pass */
  failureReason?: string;
  /** Wall-clock duration of this iteration in ms */
  durationMs: number;
}

// ─── Termination Reasons ─────────────────────────

export type TerminationReason =
  | 'tests_passed'
  | 'max_iterations'
  | 'timeout'
  | 'error';

// ─── Result ──────────────────────────────────────

export interface FixLoopResult {
  /** Whether the fix loop ended with passing tests */
  success: boolean;
  /** Total iterations executed (1-indexed count) */
  totalIterations: number;
  /** Detailed record of each iteration */
  iterations: FixLoopIteration[];
  /** Proto output from the successful iteration (if any) */
  finalProtoOutput?: ProtoOutput;
  /** Trace output from the successful iteration (if any) */
  finalTraceOutput?: TraceOutput;
  /** Why the loop stopped */
  terminationReason: TerminationReason;
  /** Error message when terminationReason is 'error' or 'timeout' */
  errorMessage?: string;
}

// ─── Callback Signatures ─────────────────────────

/**
 * Callback to run Proto agent.
 * On the first iteration feedback is undefined; on subsequent iterations
 * it contains the Trace failure summary so Proto can fix its output.
 */
export type RunProtoFn = (
  spec: StructuredSpec,
  feedback?: string,
  temperature?: number,
) => Promise<ProtoOutput>;

/**
 * Callback to run Trace agent against Proto's output.
 */
export type RunTraceFn = (
  protoOutput: ProtoOutput,
) => Promise<TraceOutput>;
