// Regression Confidence — Tier 1.A surface types.
//
// The "Bakkal-readable" answer the platform needs to deliver after an
// iteration child runs (or a root pipeline completes Trace + FixLoop):
//
//   "Bu değişiklik N dosyaya dokundu. Projenin baseline güveni: T testle
//    %P kapsam. AKIS başlangıçta K kez kendini düzeltti."
//
// All fields are JSON-serialisable so the same shape travels straight
// to the frontend without a separate DTO mapper.

export type RegressionStatus = 'verified_baseline' | 'self_healed' | 'no_baseline' | 'degraded';

export interface RegressionBaseline {
  totalTests: number;
  coveragePercentage: number;
  coveredCriteria: string[];
  uncoveredCriteria: string[];
}

export interface RegressionFixLoop {
  /** Total FixLoop iterations recorded against the relevant pipeline. */
  runs: number;
  /** Last FixLoop terminated with `tests_passed`. */
  succeeded: boolean;
  /** True when at least one FixLoop iteration was triggered. */
  triggered: boolean;
}

export interface RegressionReport {
  pipelineId: string;
  /** Set when this pipeline is an iteration child. */
  parentPipelineId?: string;
  /** Iteration child only — the user's follow-up request copy. */
  iterationRequest?: string;
  /** Iteration child only — files changed in this iteration. */
  iterationFilesChanged?: number;
  /** Baseline test summary from the relevant Trace run. `null` when never executed. */
  baseline: RegressionBaseline | null;
  fixLoop: RegressionFixLoop;
  status: RegressionStatus;
  /** Short Turkish sentence (< 80 chars) for the rail header. */
  headline: string;
  /** 2-3 sentence Turkish summary aimed at the bakkal persona. */
  bakkalSummary: string;
}
