// ─── FILE UPLOAD ──────────────────────────────────

export interface PipelineAttachment {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  type: 'text' | 'image';
}

// ─── SCRIBE ───────────────────────────────────────

export interface ScribeInput {
  idea: string;
  context?: string;
  targetStack?: string;
  attachmentContext?: string;
  /**
   * Anthropic image content blocks derived from user-uploaded image attachments.
   * When present + provider is Anthropic, Scribe calls the multimodal API so
   * the model sees the pixels rather than relying on the text-only ack prompt.
   * Issue #402 step 4.
   */
  imageBlocks?: readonly import('../../../services/ai/multimodalClient.js').AnthropicImageBlock[];
  existingRepo?: {
    owner: string;
    repo: string;
    branch: string;
  };
}

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

export interface UserFriendlyPlan {
  projectName: string;
  summary: string;
  features: Array<{ name: string; description: string }>;
  techChoices: string[];
  estimatedFiles: number;
  requiresTests: boolean;
  testRationale?: string;
}

export interface ScribeOutput {
  spec: StructuredSpec;
  plan: UserFriendlyPlan;
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

// ─── PROTO ────────────────────────────────────────

export interface ProtoInput {
  spec: StructuredSpec;
  repoName: string;
  repoVisibility: 'public' | 'private';
  owner: string;
  baseBranch?: string;
  dryRun?: boolean;
  pipelineId?: string;
  knowledgeContext?: string;
  /** Iteration mode: user's follow-up request (e.g. "fix the second input field") */
  iterationRequest?: string;
  /** Iteration mode: existing files read from GitHub to modify instead of building from scratch */
  existingFiles?: Array<{ path: string; content: string }>;
  /**
   * Iteration mode: image blocks forwarded when the user attaches screenshots
   * to their follow-up request. When present and the provider exposes a
   * multimodal path, Proto dispatches to {@link ProtoAIDeps.generateTextWithImages}
   * so the model can see the screenshots alongside the change request.
   * Issue #427 BUG-19.
   */
  imageBlocks?: readonly import('../../../services/ai/multimodalClient.js').AnthropicImageBlock[];
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
}

// ─── TRACE ────────────────────────────────────────

export interface TraceInput {
  repoOwner: string;
  repo: string;
  branch: string;
  spec?: StructuredSpec;
  dryRun?: boolean;
  pipelineId?: string;
  cucumberEnabled?: boolean;
  knowledgeContext?: string;
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
  branch?: string;
  prUrl?: string;
  /** When set, AKIS pushed `.github/workflows/akis-e2e.yml` for GitHub Actions verification */
  ciWorkflowPath?: string;
  gherkinFeatures?: Array<{
    featureName: string;
    filePath: string;
    content: string;
    scenarioCount: number;
    mappedCriteria: string[];
  }>;
  stepDefinitions?: Array<{
    filePath: string;
    content: string;
  }>;
}

// ─── PIPELINE ─────────────────────────────────────

export type PipelineStage =
  | 'scribe_clarifying'
  | 'scribe_generating'
  | 'critic_reviewing_spec'   // Level 3: CriticAgent reviews Scribe's spec
  | 'awaiting_approval'
  | 'proto_building'
  | 'critic_reviewing_code'   // Level 3: CriticAgent reviews Proto's code
  | 'trace_testing'
  | 'fix_loop_iteration'      // Level 3: FixLoop retrying Proto+Trace
  | 'ci_running' // reserved — future CI/CD integration
  | 'completed'
  | 'completed_partial'
  | 'failed'
  | 'cancelled';

export interface PipelineError {
  code: string;
  message: string;
  technicalDetail?: string;
  retryable: boolean;
  recoveryAction?: 'retry' | 'edit_spec' | 'reconnect_github' | 'start_over' | 'configure_ai_key';
}

export interface PipelineMetrics {
  startedAt: Date;
  scribeCompletedAt?: Date;
  approvedAt?: Date;
  protoCompletedAt?: Date;
  traceCompletedAt?: Date;
  totalDurationMs?: number;
  clarificationRounds: number;
  retryCount: number;
  estimatedCost?: number;
  /** Accumulated AI token usage across all stages */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PipelineState {
  id: string;
  userId: string;
  stage: PipelineStage;
  title?: string;
  model?: string;

  scribeConversation: ScribeMessageType[];
  scribeOutput?: ScribeOutput;
  approvedSpec?: StructuredSpec;
  protoOutput?: ProtoOutput;
  traceOutput?: TraceOutput;
  /** Reserved for future CI/CD integration (GitHub Actions run result) */
  ciResult?: { ok: boolean; runId: number; status: string; conclusion: string | null; htmlUrl: string };
  traceEnabled: boolean;
  protoConfig?: { repoName: string; repoVisibility: 'public' | 'private' };
  jiraConfig?: {
    projectKey: string;
    enabled: boolean;
    epicKey?: string;
  };
  repoContext?: import('../../agents/repo-context/RepoContextTypes.js').RepoContext;

  /** Level 4: Adaptive autonomy — auto-approve when critic score meets threshold */
  autoApproveEnabled?: boolean;
  autoApproveThreshold?: number; // default 85

  metrics: PipelineMetrics;
  error?: PipelineError;
  intermediateState?: Record<string, unknown>;
  attemptCount: number;
  stageVersion: number;

  createdAt: Date;
  updatedAt: Date;
}
