/**
 * Pipeline types — frontend mirror of backend pipeline contracts.
 * Used by workflow API wrappers to map raw pipeline data to UI-friendly format.
 */

export type PipelineStage =
  | 'scribe_clarifying'
  | 'scribe_generating'
  | 'critic_reviewing_spec'
  | 'awaiting_approval'
  | 'proto_building'
  | 'critic_reviewing_code'
  // P8: Critic code review came back below the approval threshold; pipeline
  // is hard-blocked until the user iterates with feedback or overrides.
  | 'awaiting_critic_resolution'
  | 'awaiting_push_confirm'
  | 'trace_testing'
  | 'fix_loop_iteration'
  | 'ci_running'
  | 'completed'
  | 'completed_partial'
  | 'failed'
  | 'cancelled';

export interface ScribeClarification {
  questions: Array<{
    id: string;
    question: string;
    reason: string;
    suggestions?: string[];
  }>;
}

export interface StructuredSpec {
  title: string;
  problemStatement: string;
  userStories: Array<{
    persona: string;
    action: string;
    benefit: string;
  }>;
  acceptanceCriteria: Array<{
    id: string;
    given: string;
    when: string;
    then: string;
  }>;
  technicalConstraints: {
    stack?: string;
    integrations?: string[];
    nonFunctional?: string[];
  };
  outOfScope: string[];
}

export interface ReviewNotes {
  selfReviewPassed?: boolean;
  revisionsApplied?: string[];
  assumptionsMade?: string[];
}

export interface ScribeOutput {
  spec: StructuredSpec;
  rawMarkdown: string;
  confidence: number;
  clarificationsAsked: number;
  reviewNotes?: string | ReviewNotes;
  assumptions?: string[];
}

/**
 * Chat agent narrator (2026-05-23) — Hat 1/Hat 2 added sub-step disclosure
 * to the chat agent bubbles. `SubStep` mirrors the backend contract; chat
 * never renders Critic/Validator as a separate bubble — they ride along as
 * sub-steps tagged by `source` instead (spec DL-2/DL-3).
 */
export interface SubStep {
  label: string;
  durationMs?: number;
  status: 'done' | 'live' | 'failed';
  source?: 'critic' | 'validator' | 'agent';
}

export type ScribeMessageType =
  | { type: 'user_idea'; content: string; timestamp?: string }
  | { type: 'clarification'; content: ScribeClarification; timestamp?: string }
  | { type: 'user_answer'; content: string; timestamp?: string }
  | { type: 'spec_draft'; content: ScribeOutput; timestamp?: string }
  | { type: 'spec_approved'; content: StructuredSpec; timestamp?: string }
  | { type: 'spec_rejected'; content: { feedback: string }; timestamp?: string }
  | { type: 'user_note'; content: string; timestamp?: string }
  | { type: 'user_feedback'; content: string; timestamp?: string }
  // Chat event-log types (2026-05-22)
  | { type: 'proto_started'; content: { iteration: number }; timestamp?: string }
  | {
      type: 'proto_completed';
      content: {
        iteration: number;
        summary: string;
        filesCreated: number;
        totalLines: number;
        branch?: string;
        // Chat narrator (2026-05-23) — backend Hat 1.
        durationMs?: number;
        subSteps?: SubStep[];
      };
      timestamp?: string;
    }
  | { type: 'trace_started'; content: { iteration: number }; timestamp?: string }
  | {
      type: 'trace_completed';
      content: {
        iteration: number;
        totalTests: number;
        coverage: number;
        passed: boolean;
        // Chat narrator (2026-05-23) — backend Hat 1.
        summary?: string;
        durationMs?: number;
        subSteps?: SubStep[];
      };
      timestamp?: string;
    }
  | {
      type: 'trace_failed';
      content: {
        iteration: number;
        errorCode: string;
        errorMessage: string;
        recoveryAction?: 'retry' | 'skip';
      };
      timestamp?: string;
    }
  | {
      type: 'scribe_failed';
      content: {
        stageStuck: PipelineStage;
        errorCode: string;
        errorMessage: string;
        recoveryAction?: 'retry';
      };
      timestamp?: string;
    }
  | {
      type: 'proto_failed';
      content: {
        iteration?: number;
        errorCode: string;
        errorMessage: string;
        recoveryAction?: 'retry';
      };
      timestamp?: string;
    }
  /**
   * Chat narrator (2026-05-23) — Hat 1 emits this once Scribe finishes a
   * tour so the chat bubble can show iteration counter, the LLM Turkish
   * summary, and sub-step disclosure (including Critic review entries).
   */
  | {
      type: 'scribe_completed';
      content: {
        iteration: number;
        summary: string;
        storyCount: number;
        acCount: number;
        durationMs?: number;
        subSteps?: SubStep[];
      };
      timestamp?: string;
    };

export interface VerificationReport {
  specCoverage: string;
  integrityIssues: string[];
  missingDependencies?: string[];
  unresolvedImports?: string[];
  confidenceScore: number;
}

export interface ProtoOutput {
  ok: boolean;
  branch: string;
  repo: string;
  repoUrl: string;
  files: Array<{
    filePath: string;
    content: string;
    linesOfCode: number;
  }>;
  prUrl?: string;
  setupCommands: string[];
  /** Optional 1-3 sentence Turkish narration shown as a chat message. */
  summary?: string;
  metadata: {
    filesCreated: number;
    totalLinesOfCode: number;
    stackUsed: string;
    committed: boolean;
  };
  verificationReport?: VerificationReport;
}

export interface TraceabilityEntry {
  criterionId: string;
  testFile: string;
  testName: string;
  coverage: 'full' | 'partial' | 'none';
}

export interface TraceOutput {
  ok: boolean;
  testFiles: Array<{
    filePath: string;
    content: string;
    testCount: number;
  }>;
  coverageMatrix: Record<string, string[]>;
  testSummary: {
    totalTests: number;
    coveragePercentage: number;
    coveredCriteria: string[];
    uncoveredCriteria: string[];
  };
  traceability?: TraceabilityEntry[];
  branch?: string;
  prUrl?: string;
  /**
   * Real test execution results from TraceAutomationRunner.
   * When present, these are actual pass/fail data — not AI estimates.
   */
  executedTestResults?: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    durationMs: number;
    details: Array<{
      name: string;
      status: 'passed' | 'failed' | 'skipped';
      error?: string;
      durationMs?: number;
    }>;
  };
}

export interface PipelineError {
  code: string;
  message: string;
  technicalDetail?: string;
  retryable: boolean;
  recoveryAction?: 'retry' | 'edit_spec' | 'reconnect_github' | 'start_over' | 'skip-trace';
}

export interface PipelineMetrics {
  startedAt: string;
  scribeCompletedAt?: string;
  approvedAt?: string;
  protoCompletedAt?: string;
  traceCompletedAt?: string;
  totalDurationMs?: number;
  clarificationRounds: number;
  retryCount: number;
}

export interface CriticFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: string;
  description: string;
  suggestion: string;
  location?: string;
}

export interface CriticReviewOutput {
  approved: boolean;
  overallScore: number;
  findings: CriticFinding[];
  summary: string;
  reviewType: 'spec_review' | 'code_review';
  iteration: number;
  /**
   * PR-F (mimari refactor 2026-05-19): backend artık findings array'inden
   * `hasCriticalFinding` ve `maxSeverity` türetir. Eski pipeline'larda
   * (PR-F öncesi run) alan yok — opsiyonel.
   */
  hasCriticalFinding?: boolean;
  maxSeverity?: 'critical' | 'major' | 'minor' | 'info';
}

export interface Pipeline {
  id: string;
  userId: string;
  stage: PipelineStage;
  title?: string;
  /** Per-chat AI model selection (issue #437). */
  model?: string;
  /** Stamped at pipeline creation (PR-A). When set, setModel returns 409. */
  modelLockedAt?: string;
  traceEnabled: boolean;
  scribeConversation: ScribeMessageType[];
  scribeOutput?: ScribeOutput;
  approvedSpec?: StructuredSpec;
  protoOutput?: ProtoOutput;
  traceOutput?: TraceOutput;
  protoConfig?: { repoName: string; repoVisibility: 'public' | 'private' };
  /**
   * T2 — Jira integration metadata. `epicKey` is filled by the backend
   * after the Jira Epic creation hook succeeds; `siteUrl` is stamped
   * alongside so the UI can construct the Epic link without a separate
   * status round-trip.
   */
  jiraConfig?: {
    projectKey: string;
    enabled: boolean;
    epicKey?: string;
    siteUrl?: string;
  };
  metrics: PipelineMetrics;
  error?: PipelineError;
  /**
   * T3: GitHub Actions run result, populated by the orchestrator's CI
   * polling step after a successful Trace + push. Surfaced via
   * `intermediateState.ciResult` from the backend.
   */
  ciResult?: {
    ok: boolean;
    runId: number;
    status: string;
    conclusion: string | null;
    htmlUrl: string;
  };
  intermediateState?: {
    criticSpecOutput?: CriticReviewOutput;
    criticCodeOutput?: CriticReviewOutput;
    /**
     * P8 — audit + visualization payload for the Critic hard-block. Present
     * once the orchestrator parked the pipeline at
     * `awaiting_critic_resolution`. `manuallyOverridden=true` after the
     * user clicked "Yine de devam et".
     */
    criticBlock?: {
      blockedAt: string;
      overallScore: number;
      findingsCount: number;
      manuallyOverridden: boolean;
      overriddenAt?: string;
    };
    /**
     * PR-D — per-AC binary coverage checklist. Replaces the mechanical
     * Proto-confidence formula. Static layer is filled once Proto produces
     * files; dynamic layer is filled once Trace runs successfully.
     */
    acCoverage?: AcCoverageReport;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
}

// ─── Level 4: Explainability ─────────────────────────────────

export interface AgentReasoning {
  agentName: string;
  /**
   * Persistence-layer stage key (`'critic-spec' | 'critic-code'` for the
   * Critic agent so two reviews don't collapse onto the same row). Falls
   * back to `agentName` when the backend did not set it.
   */
  stageKey?: string;
  timestamp: string; // ISO 8601 (backend Date → JSON string)
  decision: string;
  reasoning: string[];
  assumptions: string[];
  alternatives?: string[];
  confidence: {
    score: number;
    factors: string[];
  };
  risks?: string[];
  /** Critic only — structured findings with category + severity + suggestion. */
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
   * persistence was added (PDP-2 Wave 2, F-03 + F-11). UI shows the
   * "eski sürümde tamamlandı, açıklama kaydı yok" banner instead of
   * the generic "henüz açıklama yok" hint.
   * Backend gates the flag on terminal pipeline status — active pipelines
   * never trip it (review-fix #1).
   */
  persistencePreEpoch?: boolean;
}

/**
 * T4: one entry per completed Proto → Critic pass — captures the Proto
 * confidence and Critic verdict for that iteration so the UI can render the
 * trajectory ("Critic %52 → %67 → %84") instead of only the final score.
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
  /** Delta between first and last criticScore (positive = improvement). */
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
  meta?: PipelineExplanationMeta;
}

// ─── PR-D: AC Coverage ───────────────────────────────────────

export interface AcCoverageItem {
  acId: string;
  acDescription: string;
  /** Proto file content lightweight-matched at least one AC keyword. */
  staticCovered: boolean;
  /** Trace test references this AC (coverageMatrix or content keyword match). */
  dynamicCovered: boolean;
  /** Up to 3 Proto file paths whose content/path matched. */
  coveringFiles: string[];
  /** Up to 3 Trace test file paths whose content/path matched. */
  coveringTests: string[];
}

export interface AcCoverageReport {
  totalAcs: number;
  staticCoveredCount: number;
  dynamicCoveredCount: number;
  items: AcCoverageItem[];
}

// ─── Tier 1.A: Regression Confidence ─────────────────────────

export type RegressionStatus = 'verified_baseline' | 'self_healed' | 'no_baseline' | 'degraded';

export interface RegressionBaseline {
  totalTests: number;
  coveragePercentage: number;
  coveredCriteria: string[];
  uncoveredCriteria: string[];
}

export interface RegressionFixLoop {
  runs: number;
  succeeded: boolean;
  triggered: boolean;
}

export interface RegressionReport {
  pipelineId: string;
  parentPipelineId?: string;
  iterationRequest?: string;
  iterationFilesChanged?: number;
  baseline: RegressionBaseline | null;
  fixLoop: RegressionFixLoop;
  status: RegressionStatus;
  headline: string;
  bakkalSummary: string;
}

/**
 * P5b: AI request log viewer entry — wire format for
 * `GET /api/pipelines/:id/ai-calls`. Mirrors the backend's `AiCallEntry`.
 *
 * Content fields (systemPrompt/userPrompt/responseText/thinkingBlocks/
 * toolCalls) are nullable because pre-P5a rows did not capture them, and
 * the TraceRecorder appends `... [truncated]` when over
 * `AI_LOG_CONTENT_MAX_BYTES` (default 100KB) per field.
 */
export interface AiCallEntry {
  id: string;
  callIndex: number;
  provider: string;
  model: string;
  purpose: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  success: boolean;
  errorCode: string | null;
  timestamp: string;
  systemPrompt: string | null;
  userPrompt: string | null;
  responseText: string | null;
  thinkingBlocks: unknown[] | null;
  toolCalls: unknown[] | null;
}
