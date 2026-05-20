// Explainability Interface — Types
// Provides interpretable rationales for multi-agent pipeline decisions.
// Gartner TRiSM Framework (ScienceDirect, 2026) & EU AI Act (2024) transparency.

export interface AgentReasoning {
  agentName: string; // 'scribe' | 'critic' | 'proto' | 'trace' | 'validator' …
  /**
   * Persistence-layer stage key. Defaults to `agentName` when absent.
   *
   * The Critic emits two reasonings per pipeline (spec review + code review),
   * both with `agentName: 'critic'`. To keep the unique
   * (pipeline_id, stage) constraint on `pipeline_reasonings` correct, the
   * builder sets `stageKey` to `'critic-spec' | 'critic-code'`.
   */
  stageKey?: string;
  timestamp: Date;
  decision: string;
  reasoning: string[];
  assumptions: string[];
  alternatives?: string[];
  confidence: {
    score: number; // 0-100
    factors: string[];
  };
  risks?: string[];
  /**
   * Optional structured findings — populated for the Critic agent only.
   * Allows the UI to group by category (testability / ambiguity /
   * completeness / …) and surface severity + suggestion alongside the
   * description, instead of flattening everything into `reasoning[]`.
   */
  findings?: ReasoningFinding[];
}

export interface ReasoningFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category:
    | 'completeness'
    | 'ambiguity'
    | 'consistency'
    | 'testability'
    | 'spec_compliance'
    | 'security';
  description: string;
  suggestion: string;
  location?: string;
}

export interface AttentionPoint {
  stage: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

export interface PipelineExplanationMeta {
  /**
   * `true` when the response is empty because the pipeline ran before
   * persistence was added (PDP-2 Wave 2, F-03 + F-11). The frontend uses
   * this to render the "Bu pipeline kalıcılık güncellenmesinden önce
   * tamamlandı" banner instead of "henüz açıklama yok".
   */
  persistencePreEpoch?: boolean;
}

/**
 * T4: one entry per completed Proto → Critic pass, capturing the Proto
 * confidence and Critic verdict for that iteration so the UI can render a
 * trajectory ("Critic %52 → %67 → %84"). Iteration number is 1-indexed.
 */
export interface IterationHistoryEntry {
  iteration: number;
  protoConfidence: number | null;
  criticScore: number | null;
  criticFindingsCount: number;
  criticCriticalCount: number;
  timestamp: string;
  decision?: 'approved' | 'rejected' | 'blocked';
}

export interface IterationTrajectory {
  entries: IterationHistoryEntry[];
  /** Delta between the first and last criticScore (positive = improvement). */
  criticScoreDelta: number | null;
  finalDecision: 'approved' | 'rejected' | 'blocked' | null;
}

export interface PipelineExplanation {
  pipelineId: string;
  stages: AgentReasoning[];
  overallNarrative: string;
  attentionPoints: AttentionPoint[];
  /** T4: Critic-Proto iterate loop trajectory, when the loop ran at least once. */
  iterationTrajectory?: IterationTrajectory;
  /** Optional meta — backend hints for the explanation panel UI. */
  meta?: PipelineExplanationMeta;
}

export interface ExplainabilityConfig {
  verbosity: 'minimal' | 'standard' | 'detailed';
  includeAlternatives: boolean;
  includeRisks: boolean;
}
