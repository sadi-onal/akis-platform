/**
 * Workflow types — frontend wrapper around pipeline backend contracts.
 * "Workflow" is the UI term; backend still uses "pipeline".
 */
import type { SubStep } from './pipeline';
import type { UserFriendlyPlan } from './plan';

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'completed_partial'
  | 'failed'
  | 'cancelled';

export type StageStatus = 'idle' | 'running' | 'completed' | 'failed' | 'pending';

export interface StructuredSpec {
  title?: string;
  problemStatement: string;
  userStories: Array<{
    persona?: string;
    as?: string;
    action?: string;
    iWant?: string;
    benefit?: string;
    soThat?: string;
    priority?: 'P0' | 'P1' | 'P2';
  }>;
  acceptanceCriteria: Array<{
    id?: string;
    summary?: string;
    given: string;
    when: string;
    then: string;
  }>;
  technicalConstraints?:
    | { stack?: string; integrations?: string[]; nonFunctional?: string[] }
    | string[];
  outOfScope?: string[];
}

export interface StageResult {
  status: StageStatus;
  startTime?: string;
  endTime?: string;
  duration?: string;
  confidence?: number;
  spec?: StructuredSpec | null;
  /**
   * PR-V6-fix (2026-05-20): Scribe `assumptions` propagated through
   * `mapScribeOutput` so ChatPageLayout can thread them as
   * `scribeAssumptions` into PipelineDetailRail → ExplanationPanel.
   * Without this, the assumption disclosure (which the chat-side PlanCard
   * already had via `ConversationMessage.assumptions`) never rendered in
   * the Açıklama tab.
   */
  assumptions?: string[];
  approvedBy?: string;
  branch?: string;
  repo?: string;
  repoUrl?: string;
  files?: string[];
  tests?: number;
  coverage?: string;
  error?: string;
  elapsed?: string;
}

export interface WorkflowStages {
  scribe: StageResult;
  approve: StageResult;
  proto: StageResult;
  trace: StageResult;
}

// ═══ Conversation Types ═══

export interface ConversationMessage {
  role: 'user' | 'scribe' | 'proto' | 'trace' | 'system';
  type:
    | 'message'
    | 'clarification'
    | 'spec'
    | 'proto_result'
    | 'trace_result'
    | 'error'
    | 'proto_started'
    | 'trace_started'
    | 'trace_failed'
    | 'scribe_failed'
    | 'proto_failed'
    /**
     * Chat narrator (2026-05-23) — `mapConversation` synthesises this row
     * when the backend emits a `scribe_completed` event-log entry. The
     * ChatMessage path renders it as a Scribe agent bubble carrying the LLM
     * Turkish summary, sub-step disclosure, duration footer, and optionally
     * the embedded plan card.
     */
    | 'scribe_completed';
  content: string;
  timestamp: string;
  // Clarification
  questions?: Array<{
    id: string;
    question: string;
    reason: string;
    suggestions?: string[];
  }>;
  // Spec
  spec?: StructuredSpec;
  confidence?: number;
  reviewNotes?:
    | string
    | {
        selfReviewPassed?: boolean;
        revisionsApplied?: string[];
        assumptionsMade?: string[];
      };
  assumptions?: string[];
  // Proto result
  protoResult?: {
    branch: string;
    repo: string;
    files: FileTreeNode[];
    totalFiles: number;
    totalLines: number;
    /** Optional 1-3 sentence Turkish narration of what Proto built. */
    summary?: string;
    verificationReport?: {
      specCoverage: string;
      integrityIssues: string[];
      confidenceScore: number;
    };
  };
  // Chat event-log (2026-05-22)
  iteration?: number;
  errorCode?: string;
  errorMessage?: string;
  recoveryAction?: 'retry' | 'skip';
  /** scribe_failed only — backend PipelineStage; widened to string on FE. */
  stageStuck?: string;
  /**
   * Chat narrator (2026-05-23) — `mapConversation` lifts the new server-truth
   * narrator fields to the conversation row so `conversationToChatMessages`
   * can pass them through to the rendered ChatMessage:
   *
   * - `durationMs`: completed runtime (server-truth, NF-2). Absent ⇒ no footer.
   * - `subSteps`:   collapsed disclosure rows (includes Critic + Validator).
   * - `summary`:    Trace LLM summary (Proto's `summary` lives under
   *                 `protoResult.summary`; this is the spot for Trace + Scribe).
   * - `embeddedPlan`: only set for `scribe_completed` rows — the plan card the
   *                 chat embeds inside Scribe's last bubble (DL-7). Older
   *                 pipelines still rely on the standalone `'plan'`
   *                 ChatMessage; both paths cannot coexist for the same run
   *                 because `conversationToChatMessages` guards on the
   *                 presence of `scribe_completed`.
   */
  durationMs?: number;
  subSteps?: SubStep[];
  summary?: string;
  embeddedPlan?: {
    plan: UserFriendlyPlan;
    version: number;
    status: 'active' | 'edited' | 'approved' | 'rejected' | 'cancelled';
    spec?: StructuredSpec;
    assumptions?: string[];
  };
  // Trace result
  traceResult?: {
    testCount: number;
    passing: number;
    failing: number;
    coverage: string;
    duration: string;
    testFiles: FileTreeNode[];
    traceability?: Array<{
      criterionId: string;
      testFile: string;
      testName: string;
      coverage: 'full' | 'partial' | 'none';
    }>;
    gherkinFeatures?: Array<{
      featureName: string;
      filePath: string;
      content: string;
      scenarioCount: number;
      mappedCriteria: string[];
    }>;
  };
}

export interface FileTreeNode {
  name: string;
  type: 'file' | 'folder';
  path?: string;
  lang?: string;
  lines?: number;
  content?: string;
  agent?: 'proto' | 'trace';
  status?: 'new' | 'modified' | 'test';
  children?: FileTreeNode[];
}

export interface WorkflowTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
  percentUsed: number;
  model: string;
}

export interface Workflow {
  id: string;
  title: string;
  status: WorkflowStatus;
  currentStage?: import('./pipeline').PipelineStage;
  traceEnabled: boolean;
  createdAt: string;
  updatedAt?: string;
  stages: WorkflowStages;
  conversation?: ConversationMessage[];
  /** Pipeline error details — present when status is 'failed'. */
  error?: import('./pipeline').PipelineError;
  /**
   * Live chat-level token usage + context-window gauge data. Supplied by
   * `GET /api/pipelines/:id` response top-level field (not nested under
   * `pipeline.metrics`) so the gauge can read mid-stage accumulator values
   * that have not yet been flushed to DB. Issue #438.
   */
  tokenUsage?: WorkflowTokenUsage;
  /** Per-chat AI model selection (issue #437). */
  model?: string;
  /** Pipeline creation stamp; ModelPicker locks when present (PR-A Commit 5). */
  modelLockedAt?: string;
  /**
   * P8 — latest Critic code-review output (mirror of
   * `pipeline.intermediateState.criticCodeOutput`). Used by ChatPanel to
   * render the score bar + resolution gate at `awaiting_critic_resolution`.
   */
  criticReview?: import('./pipeline').CriticReviewOutput;
  /**
   * P8 — audit metadata stamped when the orchestrator parks the pipeline
   * at `awaiting_critic_resolution`. `manuallyOverridden=true` after the
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
   * PR-D — per-AC binary coverage checklist (mirror of
   * `pipeline.intermediateState.acCoverage`). Threaded into ChatPanel →
   * PipelineDetailRail → ExplanationPanel so the Proto reasoning card
   * renders the checklist instead of the legacy bullet list.
   */
  acCoverage?: import('./pipeline').AcCoverageReport;
  /**
   * PR-U3 M3 — outcome of the Trace dryRun that precedes the push gate.
   * Drives PushConfirmGate's 3-mode rendering:
   *   - `success`: gate behaves normally
   *   - `failed`: warning banner + explicit override checkbox before push
   *   - `pending`: spinner + push button disabled
   */
  traceDryRunStatus?: 'success' | 'failed' | 'pending';
  /** Error code from a failed Trace dryRun (only present when status='failed'). */
  traceDryRunErrorCode?: string;
  /**
   * PR-U3 M7 — true when the orchestrator failed to persist explainability
   * reasoning after retries. The Açıklama panel uses this to show a
   * graceful banner instead of an empty card.
   */
  explainabilityDegraded?: boolean;
  /**
   * T2 — Jira integration metadata. Present when the user enabled Jira at
   * pipeline creation; `epicKey` lands once the Epic is created, `siteUrl`
   * is stamped alongside so the UI can render a clickable Epic link.
   */
  jiraConfig?: {
    projectKey: string;
    enabled: boolean;
    epicKey?: string;
    siteUrl?: string;
  };
  /**
   * T3 — GitHub Actions CI run result. Surfaced from
   * `pipeline.intermediateState.ciResult` so the rail can render a CI pill
   * (✓/✗) without traversing intermediateState. `htmlUrl` is always present
   * on the row, even on failure.
   */
  ciResult?: {
    ok: boolean;
    runId: number;
    status: string;
    conclusion: string | null;
    htmlUrl: string;
  };
}

export interface WorkflowStats {
  total: number;
  completed: number;
  running: number;
  failed: number;
  avgDuration: string;
  testsGenerated: number;
  successRate: number;
  thisWeek: number;
}

/**
 * F-04 helper — does this workflow have any persisted output worth showing?
 *
 * Used to decide whether the Pipeline detail rail should stay mounted for
 * completed pipelines whose in-memory activity buffer was lost (e.g. after
 * backend restart). Outputs persist on the workflow record, so we treat them
 * as the "has something to show" signal even when the live activities array
 * is empty.
 *
 * Cheap O(1) check — call inline at render time. No useMemo needed.
 *
 * Reusable: dashboard / conversation list will likely need the same signal
 * once F-03 (activity persistence, NFR-1) lands.
 */
export function hasPipelineOutputs(w: Workflow | null | undefined): boolean {
  if (!w?.stages) return false;
  return Boolean(
    (w.stages.proto?.files?.length ?? 0) > 0 ||
      (w.stages.trace?.tests ?? 0) > 0 ||
      w.stages.scribe?.spec
  );
}
