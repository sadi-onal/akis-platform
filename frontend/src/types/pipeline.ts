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

export type ScribeMessageType =
  | { type: 'user_idea'; content: string }
  | { type: 'clarification'; content: ScribeClarification }
  | { type: 'user_answer'; content: string }
  | { type: 'spec_draft'; content: ScribeOutput }
  | { type: 'spec_approved'; content: StructuredSpec }
  | { type: 'spec_rejected'; content: { feedback: string } }
  | { type: 'user_note'; content: string };

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
}

export interface Pipeline {
  id: string;
  userId: string;
  stage: PipelineStage;
  title?: string;
  /** Per-chat AI model selection (issue #437). */
  model?: string;
  traceEnabled: boolean;
  scribeConversation: ScribeMessageType[];
  scribeOutput?: ScribeOutput;
  approvedSpec?: StructuredSpec;
  protoOutput?: ProtoOutput;
  traceOutput?: TraceOutput;
  protoConfig?: { repoName: string; repoVisibility: 'public' | 'private' };
  metrics: PipelineMetrics;
  error?: PipelineError;
  intermediateState?: {
    criticSpecOutput?: CriticReviewOutput;
    criticCodeOutput?: CriticReviewOutput;
    engineerSessionId?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
}
