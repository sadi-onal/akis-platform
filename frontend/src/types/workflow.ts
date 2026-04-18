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
  /**
   * Set when the pipeline was started by an Engineer Rental Mode session.
   * The chat UI uses this to render an "engineer-owned" badge in the sidebar
   * and a banner linking back to `/engineer/session/:engineerSessionId`, so
   * the session context is not lost when the user drifts to the pipeline's
   * chat row (BUG-24 / #434).
   */
  engineerSessionId?: string;
  /**
   * Live chat-level token usage + context-window gauge data. Supplied by
   * `GET /api/pipelines/:id` response top-level field (not nested under
   * `pipeline.metrics`) so the gauge can read mid-stage accumulator values
   * that have not yet been flushed to DB. Issue #438.
   */
  tokenUsage?: WorkflowTokenUsage;
  /** Per-chat AI model selection (issue #437). */
  model?: string;
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
