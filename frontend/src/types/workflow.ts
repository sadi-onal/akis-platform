/**
 * Workflow types — frontend wrapper around pipeline backend contracts.
 * "Workflow" is the UI term; backend still uses "pipeline".
 */

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
  technicalConstraints?: { stack?: string; integrations?: string[]; nonFunctional?: string[] } | string[];
  outOfScope?: string[];
}

export interface StageResult {
  status: StageStatus;
  startTime?: string;
  endTime?: string;
  duration?: string;
  confidence?: number;
  spec?: StructuredSpec | null;
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
  type: 'message' | 'clarification' | 'spec' | 'proto_result' | 'trace_result' | 'error';
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
  reviewNotes?: string | {
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
