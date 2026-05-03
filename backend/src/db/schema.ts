import { pgTable, uuid, varchar, jsonb, timestamp, pgEnum, text, index, boolean, integer, uniqueIndex, numeric, customType, real } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// pgvector custom type for embedding columns (1536 dimensions for text-embedding-3-small)
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() { return 'vector(384)'; },
  toDriver(value: number[]) { return `[${value.join(',')}]`; },
  fromDriver(value: string) {
    if (typeof value === 'string') {
      const clean = value.startsWith('[') ? value : `[${value}]`;
      return JSON.parse(clean);
    }
    return value as unknown as number[];
  },
});

export const jobStateEnum = pgEnum('job_state', ['pending', 'running', 'completed', 'failed', 'awaiting_approval']);

// ============================================================================
// Crew System Enums (M2: Agent Teams)
// ============================================================================
export const crewRunStatusEnum = pgEnum('crew_run_status', [
  'planning', 'spawning', 'running', 'merging', 'completed', 'failed',
]);

export const crewTaskStatusEnum = pgEnum('crew_task_status', [
  'pending', 'in_progress', 'completed', 'blocked',
]);

export const crewMessageTypeEnum = pgEnum('crew_message_type', [
  'chat', 'task_update', 'status_report', 'challenge', 'directive',
]);

export const auditPhaseEnum = pgEnum('audit_phase', ['plan', 'execute', 'reflect', 'validate']);

/**
 * Trace event types for job execution tracking
 * S1.0: Scribe Observability - structured trace timeline
 * S1.1: Explainability UI - tool calls, decisions, reasoning
 */
export const traceEventTypeEnum = pgEnum('trace_event_type', [
  'step_start',    // Agent step started
  'step_complete', // Agent step completed
  'step_failed',   // Agent step failed
  'doc_read',      // Document/file read from source
  'file_created',  // File created/produced
  'file_modified', // File modified
  'mcp_connect',   // MCP gateway connection attempt
  'mcp_call',      // MCP tool call
  'ai_call',       // AI/LLM call
  'ai_parse_error', // AI response parse error (fallback used)
  'error',         // General error event
  'info',          // Informational event
  // S1.1: Explainability types
  'tool_call',     // External tool invocation (Asked)
  'tool_result',   // Tool response (Did)
  'decision',      // Agent decision point (Why)
  'plan_step',     // Plan step execution
  'reasoning',     // Reasoning summary
]);

export const threadStatusEnum = pgEnum('thread_status', [
  'active',
  'awaiting_user_input',
  'awaiting_plan_selection',
  'queued',
  'completed',
  'failed',
]);

export const threadMessageRoleEnum = pgEnum('thread_message_role', ['system', 'user', 'agent']);
export const planCandidateStatusEnum = pgEnum('plan_candidate_status', ['unbuilt', 'queued', 'building', 'built', 'failed']);
export const threadTaskStatusEnum = pgEnum('thread_task_status', ['pending', 'awaiting_user_input', 'answered', 'completed', 'failed']);

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: varchar('type', { length: 50 }).notNull(),
  state: jobStateEnum('state').default('pending').notNull(),
  payload: jsonb('payload'),
  result: jsonb('result'),
  error: varchar('error', { length: 1000 }),
  /** Structured error code for classification (e.g., AI_RATE_LIMITED, MCP_UNREACHABLE) */
  errorCode: varchar('error_code', { length: 50 }),
  /** User-friendly error message */
  errorMessage: varchar('error_message', { length: 500 }),
  /** Full structured error payload for debugging (JSON-serialized) */
  rawErrorPayload: text('raw_error_payload'),
  /** MCP Gateway URL used for this job (for diagnostics) */
  mcpGatewayUrl: varchar('mcp_gateway_url', { length: 255 }),
  /** AI provider requested at job submission (e.g., openai) */
  aiProvider: varchar('ai_provider', { length: 50 }),
  /** AI model requested at job submission (e.g., gpt-4o-mini) */
  aiModel: varchar('ai_model', { length: 255 }),
  /** Resolved AI provider actually used at runtime */
  aiProviderResolved: varchar('ai_provider_resolved', { length: 50 }),
  /** Resolved AI model actually used at runtime */
  aiModelResolved: varchar('ai_model_resolved', { length: 255 }),
  /** Key source: 'user' = user's stored key, 'env' = environment/server key */
  aiKeySource: varchar('ai_key_source', { length: 20 }),
  /** Fallback reason if env key used instead of user key (e.g., USER_KEY_MISSING) */
  aiFallbackReason: varchar('ai_fallback_reason', { length: 100 }),
  /** Aggregate AI duration (ms) */
  aiTotalDurationMs: integer('ai_total_duration_ms'),
  /** Aggregate input tokens */
  aiInputTokens: integer('ai_input_tokens'),
  /** Aggregate output tokens */
  aiOutputTokens: integer('ai_output_tokens'),
  /** Aggregate total tokens */
  aiTotalTokens: integer('ai_total_tokens'),
  /** Estimated cost in USD (optional, estimate) */
  aiEstimatedCostUsd: numeric('ai_estimated_cost_usd', { precision: 12, scale: 6 }),
  /** Whether this job requires strong-model validation before completion */
  requiresStrictValidation: boolean('requires_strict_validation').default(false).notNull(),
  // S1.2: Approval system for PLAN_ONLY → EXECUTE workflow
  /** Whether this job requires approval before execution */
  requiresApproval: boolean('requires_approval').default(false).notNull(),
  /** User who approved this job */
  approvedBy: uuid('approved_by').references(() => users.id),
  /** Timestamp when job was approved */
  approvedAt: timestamp('approved_at'),
  /** User who rejected this job */
  rejectedBy: uuid('rejected_by').references(() => users.id),
  /** Timestamp when job was rejected */
  rejectedAt: timestamp('rejected_at'),
  /** Comment on approval/rejection */
  approvalComment: text('approval_comment'),
  // PR-2: Revision chain support
  /** Parent job ID for revision chain (null if original job) */
  parentJobId: uuid('parent_job_id'),
  /** User instruction for revision (what to change) */
  revisionNote: text('revision_note'),
  /** Quality score (0-100) computed from job results */
  qualityScore: integer('quality_score'),
  /** Quality breakdown details (JSON: {label, value, points}[]) */
  qualityBreakdown: jsonb('quality_breakdown'),
  /** Quality algorithm version for future migrations */
  qualityVersion: varchar('quality_version', { length: 20 }),
  /** When quality was computed */
  qualityComputedAt: timestamp('quality_computed_at'),
  // M2: Crew System fields
  /** Crew run this job belongs to (null if standalone) */
  crewRunId: uuid('crew_run_id'),
  /** Worker role within the crew (e.g., 'content', 'ui', 'seo') */
  workerRole: varchar('worker_role', { length: 100 }),
  /** Worker index within the crew (0-based) */
  workerIndex: integer('worker_index'),
  /** Worker color for UI display (hex, e.g., '#10B981') */
  workerColor: varchar('worker_color', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  // Phase 7.D: Index for efficient jobs listing (type, state, createdAt DESC)
  typeStateCreatedIdx: index('idx_jobs_type_state_created').on(table.type, table.state, table.createdAt),
  // S1.2: Index for approval queries
  requiresApprovalIdx: index('idx_jobs_requires_approval').on(table.requiresApproval),
  approvedByIdx: index('idx_jobs_approved_by').on(table.approvedBy),
  // PR-2: Index for revision chain queries
  parentJobIdIdx: index('idx_jobs_parent_job_id').on(table.parentJobId),
  // M2: Crew system queries
  crewRunIdIdx: index('idx_jobs_crew_run_id').on(table.crewRunId),
}));

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Job plans - stores planning phase output (contract-first)
 * Phase 5.E: Plan storage for complex agents
 * PR-1: Extended with plan_markdown and plan_json for contract-first workflow
 */
export const jobPlans = pgTable('job_plans', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  /** Legacy: Array of plan steps (backward compat) */
  steps: jsonb('steps'), // Array<{id: string; title: string; detail?: string}>
  /** Legacy: Plan rationale (backward compat) */
  rationale: text('rationale'),
  /** 
   * PR-1: Contract-first plan document (Markdown)
   * Contains: Objective, Scope, Plan, Validation, Rollback, Docs, AI Disclosure, Evidence
   */
  planMarkdown: text('plan_markdown'),
  /**
   * PR-1: Structured plan data (JSON)
   * For programmatic access to plan sections
   */
  planJson: jsonb('plan_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  jobIdIdx: index('idx_job_plans_job_id').on(table.jobId),
}));

export type JobPlan = typeof jobPlans.$inferSelect;
export type NewJobPlan = typeof jobPlans.$inferInsert;

/**
 * Job audits - stores audit trail for plan/execute/reflect phases
 * Phase 5.E: Audit trail for governance and debugging
 */
export const jobAudits = pgTable('job_audits', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  phase: auditPhaseEnum('phase').notNull(), // 'plan' | 'execute' | 'reflect'
  payload: jsonb('payload').notNull(), // Critique, plan, or execution artifact
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type JobAudit = typeof jobAudits.$inferSelect;
export type NewJobAudit = typeof jobAudits.$inferInsert;

/**
 * Job comments - stores user feedback on jobs
 * PR-2: Feedback loop - users can leave comments for revision
 */
export const jobComments = pgTable('job_comments', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  commentText: text('comment_text').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  jobIdIdx: index('idx_job_comments_job_id').on(table.jobId),
  createdAtIdx: index('idx_job_comments_created_at').on(table.createdAt),
}));

export type JobComment = typeof jobComments.$inferSelect;
export type NewJobComment = typeof jobComments.$inferInsert;

/**
 * Job traces - stores execution timeline events
 * S1.0: Scribe Observability - structured trace timeline
 * S1.1: Explainability UI - reasoning summaries, Asked/Did/Why
 */
export const jobTraces = pgTable('job_traces', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  eventType: traceEventTypeEnum('event_type').notNull(),
  /** Step ID if this trace is associated with a plan step */
  stepId: varchar('step_id', { length: 100 }),
  /** Event title/summary */
  title: varchar('title', { length: 500 }).notNull(),
  /** Event details (JSON for flexibility) - raw, server-side only */
  detail: jsonb('detail'),
  /** Duration in milliseconds (for timed events) */
  durationMs: integer('duration_ms'),
  /** Status: success, failed, warning, info */
  status: varchar('status', { length: 20 }).default('info'),
  /** Correlation ID for MCP/external calls */
  correlationId: varchar('correlation_id', { length: 100 }),
  /** Gateway URL for MCP events */
  gatewayUrl: varchar('gateway_url', { length: 500 }),
  /** Error code if failed */
  errorCode: varchar('error_code', { length: 50 }),
  /** Timestamp of the event */
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  // S1.1: Explainability fields
  /** Tool name for tool_call/tool_result events */
  toolName: varchar('tool_name', { length: 100 }),
  /** Summary of input/arguments (redacted, user-facing) */
  inputSummary: text('input_summary'),
  /** Summary of output/result (redacted, user-facing) */
  outputSummary: text('output_summary'),
  /** User-facing reasoning summary (2-4 sentences, never raw chain-of-thought) */
  reasoningSummary: varchar('reasoning_summary', { length: 1000 }),
  /** "Asked" - What did the agent ask the tool to do? */
  askedWhat: text('asked_what'),
  /** "Did" - What action was taken? */
  didWhat: text('did_what'),
  /** "Why" - Why was this action taken? (user-facing reason) */
  whyReason: text('why_reason'),
}, (table) => ({
  jobIdIdx: index('idx_job_traces_job_id').on(table.jobId),
  eventTypeIdx: index('idx_job_traces_event_type').on(table.eventType),
  toolNameIdx: index('idx_job_traces_tool_name').on(table.toolName),
}));

export type JobTrace = typeof jobTraces.$inferSelect;
export type NewJobTrace = typeof jobTraces.$inferInsert;

/**
 * Job AI calls - stores per-call AI metrics for detailed breakdown
 * Enables: total tokens/cost, per-call breakdown, model usage analytics
 */
export const jobAiCalls = pgTable('job_ai_calls', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  /** Call index within the job (0-based, for ordering) */
  callIndex: integer('call_index').notNull(),
  /** AI provider used for this call */
  provider: varchar('provider', { length: 50 }).notNull(),
  /** AI model used for this call */
  model: varchar('model', { length: 255 }).notNull(),
  /** Purpose/description of the AI call */
  purpose: varchar('purpose', { length: 255 }),
  /** Input tokens for this call */
  inputTokens: integer('input_tokens'),
  /** Output tokens for this call */
  outputTokens: integer('output_tokens'),
  /** Total tokens for this call */
  totalTokens: integer('total_tokens'),
  /** Duration in milliseconds */
  durationMs: integer('duration_ms'),
  /** Estimated cost in USD for this call */
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 }),
  /** Whether the call succeeded */
  success: boolean('success').default(true).notNull(),
  /** Error code if failed */
  errorCode: varchar('error_code', { length: 50 }),
  /** Timestamp of the call */
  timestamp: timestamp('timestamp').defaultNow().notNull(),
}, (table) => ({
  jobIdIdx: index('idx_job_ai_calls_job_id').on(table.jobId),
  jobIdCallIndexIdx: index('idx_job_ai_calls_job_id_call_index').on(table.jobId, table.callIndex),
}));

export type JobAiCall = typeof jobAiCalls.$inferSelect;
export type NewJobAiCall = typeof jobAiCalls.$inferInsert;

/**
 * Job artifacts - stores files/documents produced by jobs
 * S1.0: Scribe Observability - artifacts tracking
 * S1.1: Explainability UI - diff previews for changed files
 */
export const jobArtifacts = pgTable('job_artifacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  /** Artifact type: doc_read, file_created, file_modified */
  artifactType: varchar('artifact_type', { length: 50 }).notNull(),
  /** File path or document identifier */
  path: varchar('path', { length: 1000 }).notNull(),
  /** Operation performed: read, create, modify, delete */
  operation: varchar('operation', { length: 20 }).notNull(),
  /** Size in bytes (if applicable) */
  sizeBytes: integer('size_bytes'),
  /** Content hash (SHA-256, for deduplication/verification) */
  contentHash: varchar('content_hash', { length: 64 }),
  /** Preview/excerpt (truncated, max 1KB) */
  preview: text('preview'),
  /** Additional metadata (JSON) */
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // S1.1: Diff preview fields
  /** Unified diff preview for modified files (truncated) */
  diffPreview: text('diff_preview'),
  /** Number of lines added */
  linesAdded: integer('lines_added'),
  /** Number of lines removed */
  linesRemoved: integer('lines_removed'),
}, (table) => ({
  jobIdIdx: index('idx_job_artifacts_job_id').on(table.jobId),
  artifactTypeIdx: index('idx_job_artifacts_type').on(table.artifactType),
}));

export type JobArtifact = typeof jobArtifacts.$inferSelect;
export type NewJobArtifact = typeof jobArtifacts.$inferInsert;

/**
 * Conversation threads - persistent multi-agent chat threads
 */
export const conversationThreads = pgTable('conversation_threads', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull().default('New conversation'),
  status: threadStatusEnum('status').notNull().default('active'),
  agentType: varchar('agent_type', { length: 50 }).notNull().default('scribe'),
  activeRuns: integer('active_runs').notNull().default(0),
  lastMessageAt: timestamp('last_message_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_conversation_threads_user_id').on(table.userId),
  userStatusUpdatedIdx: index('idx_conversation_threads_user_status_updated').on(table.userId, table.status, table.updatedAt),
}));

export type ConversationThread = typeof conversationThreads.$inferSelect;
export type NewConversationThread = typeof conversationThreads.$inferInsert;

/**
 * Conversation messages - ordered chat history inside thread
 */
export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => conversationThreads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: threadMessageRoleEnum('role').notNull(),
  agentType: varchar('agent_type', { length: 50 }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  threadCreatedIdx: index('idx_conversation_messages_thread_created').on(table.threadId, table.createdAt),
  userCreatedIdx: index('idx_conversation_messages_user_created').on(table.userId, table.createdAt),
}));

export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;

/**
 * Thread tasks - uncertainty gate and ask/wait/resume lifecycle
 */
export const threadTasks = pgTable('thread_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => conversationThreads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: threadTaskStatusEnum('status').notNull().default('pending'),
  prompt: text('prompt').notNull(),
  question: text('question'),
  answer: text('answer'),
  uncertaintyScore: numeric('uncertainty_score', { precision: 5, scale: 2 }),
  resumeToken: varchar('resume_token', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  answeredAt: timestamp('answered_at'),
}, (table) => ({
  threadStatusIdx: index('idx_thread_tasks_thread_status').on(table.threadId, table.status),
  userCreatedIdx: index('idx_thread_tasks_user_created').on(table.userId, table.createdAt),
}));

export type ThreadTask = typeof threadTasks.$inferSelect;
export type NewThreadTask = typeof threadTasks.$inferInsert;

/**
 * Plan candidates - one or more buildable plans per thread
 */
export const planCandidates = pgTable('plan_candidates', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => conversationThreads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceMessageId: uuid('source_message_id').references(() => conversationMessages.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary').notNull(),
  sourcePrompt: text('source_prompt').notNull(),
  status: planCandidateStatusEnum('status').notNull().default('unbuilt'),
  selected: boolean('selected').notNull().default(false),
  buildJobId: uuid('build_job_id').references(() => jobs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  threadStatusUpdatedIdx: index('idx_plan_candidates_thread_status_updated').on(table.threadId, table.status, table.updatedAt),
  userCreatedIdx: index('idx_plan_candidates_user_created').on(table.userId, table.createdAt),
}));

export type PlanCandidate = typeof planCandidates.$inferSelect;
export type NewPlanCandidate = typeof planCandidates.$inferInsert;

/**
 * Plan candidate builds - immutable build attempts
 */
export const planCandidateBuilds = pgTable('plan_candidate_builds', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => conversationThreads.id, { onDelete: 'cascade' }),
  planCandidateId: uuid('plan_candidate_id').notNull().references(() => planCandidates.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: planCandidateStatusEnum('status').notNull().default('queued'),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  threadCreatedIdx: index('idx_plan_candidate_builds_thread_created').on(table.threadId, table.createdAt),
  candidateCreatedIdx: index('idx_plan_candidate_builds_candidate_created').on(table.planCandidateId, table.createdAt),
}));

export type PlanCandidateBuild = typeof planCandidateBuilds.$inferSelect;
export type NewPlanCandidateBuild = typeof planCandidateBuilds.$inferInsert;

/**
 * Thread trust snapshots - reliability/hallucination/task/tool health bars
 */
export const threadTrustSnapshots = pgTable('thread_trust_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: uuid('thread_id').notNull().references(() => conversationThreads.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  reliability: integer('reliability').notNull(),
  hallucinationRisk: integer('hallucination_risk').notNull(),
  taskSuccess: integer('task_success').notNull(),
  toolHealth: integer('tool_health').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  threadCreatedIdx: index('idx_thread_trust_snapshots_thread_created').on(table.threadId, table.createdAt),
  userCreatedIdx: index('idx_thread_trust_snapshots_user_created').on(table.userId, table.createdAt),
}));

export type ThreadTrustSnapshot = typeof threadTrustSnapshots.$inferSelect;
export type NewThreadTrustSnapshot = typeof threadTrustSnapshots.$inferInsert;

/**
 * Studio sessions — workspace + file tree + command + patch context
 */
export const studioSessionStateEnum = pgEnum('studio_session_state', [
  'active',
  'paused',
  'completed',
  'archived',
]);

export const studioSessions = pgTable('studio_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 256 }).notNull(),
  repoUrl: varchar('repo_url', { length: 512 }),
  branch: varchar('branch', { length: 256 }),
  state: studioSessionStateEnum('state').notNull().default('active'),
  workspace: jsonb('workspace').notNull().default({}),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('idx_studio_sessions_user').on(table.userId),
  stateIdx: index('idx_studio_sessions_state').on(table.state),
}));

export type StudioSession = typeof studioSessions.$inferSelect;
export type NewStudioSession = typeof studioSessions.$inferInsert;

/**
 * User status enum - tracks account state
 */
export const userStatusEnum = pgEnum('user_status', [
  'pending_verification',
  'active',
  'disabled',
  'deleted',
]);

/**
 * AI Provider enum for user settings
 */
export const aiProviderEnum = pgEnum('ai_provider', ['anthropic', 'openai']);
export const userRoleEnum = pgEnum('user_role', ['admin', 'member']);

/**
 * Users table - stores user accounts for authentication
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  status: userStatusEnum('status').default('pending_verification').notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  dataSharingConsent: boolean('data_sharing_consent'),
  hasSeenBetaWelcome: boolean('has_seen_beta_welcome').default(false).notNull(),
  /** User's active AI provider for Scribe and other AI features */
  activeAiProvider: aiProviderEnum('active_ai_provider').default('anthropic'),
  /** User role for access control */
  role: userRoleEnum('role').notNull().default('member'),
  /** GitHub username (cached from API validation) */
  githubUsername: text('github_username'),
  /** GitHub avatar URL (cached from API validation) */
  githubAvatarUrl: text('github_avatar_url'),
  /** User-uploaded profile picture (data URL for MVP; OCI Object Storage follow-up). */
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: false }).defaultNow(),
}, (table) => ({
  emailIdx: index('idx_users_email').on(table.email),
  statusIdx: index('idx_users_status').on(table.status),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ============================================================================
// Marketplace: AKIS Workstream (Freelancer Marketplace MVP)
// ============================================================================

export const profiles = pgTable('profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  headline: varchar('headline', { length: 255 }),
  bio: text('bio'),
  seniority: varchar('seniority', { length: 50 }).notNull().default('mid'),
  languages: jsonb('languages').$type<string[]>().notNull().default([]),
  preferredLocations: jsonb('preferred_locations').$type<string[]>().notNull().default([]),
  remoteOnly: boolean('remote_only').notNull().default(false),
  salaryFloor: integer('salary_floor'),
  excludedIndustries: jsonb('excluded_industries').$type<string[]>().notNull().default([]),
  verificationStatus: varchar('verification_status', { length: 50 }).notNull().default('unverified'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdUnique: uniqueIndex('idx_profiles_user_id_unique').on(table.userId),
  verificationIdx: index('idx_profiles_verification').on(table.verificationStatus),
}));

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export const skills = pgTable('skills', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  level: integer('level').notNull().default(3),
  yearsExperience: numeric('years_experience', { precision: 4, scale: 1 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  profileIdIdx: index('idx_skills_profile_id').on(table.profileId),
  profileSkillUnique: uniqueIndex('idx_skills_profile_name_unique').on(table.profileId, table.name),
}));

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export const portfolios = pgTable('portfolios', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  url: varchar('url', { length: 2000 }),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  profileIdIdx: index('idx_portfolios_profile_id').on(table.profileId),
}));

export type Portfolio = typeof portfolios.$inferSelect;
export type NewPortfolio = typeof portfolios.$inferInsert;

export const jobSources = pgTable('job_sources', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull().default('manual'),
  baseUrl: varchar('base_url', { length: 2000 }),
  isActive: boolean('is_active').notNull().default(true),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(60),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index('idx_job_sources_type').on(table.type),
  activeIdx: index('idx_job_sources_active').on(table.isActive),
}));

export type JobSource = typeof jobSources.$inferSelect;
export type NewJobSource = typeof jobSources.$inferInsert;

export const jobPosts = pgTable('job_posts', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceId: uuid('source_id').notNull().references(() => jobSources.id, { onDelete: 'restrict' }),
  externalId: varchar('external_id', { length: 255 }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description').notNull(),
  requiredSkills: jsonb('required_skills').$type<string[]>().notNull().default([]),
  keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
  seniority: varchar('seniority', { length: 50 }),
  language: varchar('language', { length: 20 }),
  location: varchar('location', { length: 255 }),
  remoteAllowed: boolean('remote_allowed').notNull().default(true),
  budgetMin: numeric('budget_min', { precision: 12, scale: 2 }),
  budgetMax: numeric('budget_max', { precision: 12, scale: 2 }),
  currency: varchar('currency', { length: 8 }).notNull().default('USD'),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sourceIdIdx: index('idx_job_posts_source_id').on(table.sourceId),
  sourceExternalUnique: uniqueIndex('idx_job_posts_source_external_unique').on(table.sourceId, table.externalId),
  ingestedAtIdx: index('idx_job_posts_ingested_at').on(table.ingestedAt),
}));

export type JobPost = typeof jobPosts.$inferSelect;
export type NewJobPost = typeof jobPosts.$inferInsert;

export const matches = pgTable('matches', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  jobPostId: uuid('job_post_id').notNull().references(() => jobPosts.id, { onDelete: 'cascade' }),
  score: numeric('score', { precision: 5, scale: 4 }).notNull(),
  explanation: jsonb('explanation').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 30 }).notNull().default('suggested'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  profileIdx: index('idx_matches_profile_id').on(table.profileId),
  jobPostIdx: index('idx_matches_job_post_id').on(table.jobPostId),
  profileJobUnique: uniqueIndex('idx_matches_profile_job_unique').on(table.profileId, table.jobPostId),
}));

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;

export const proposals = pgTable('proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  jobPostId: uuid('job_post_id').notNull().references(() => jobPosts.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  source: varchar('source', { length: 30 }).notNull().default('template'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  profileIdx: index('idx_proposals_profile_id').on(table.profileId),
  jobPostIdx: index('idx_proposals_job_post_id').on(table.jobPostId),
}));

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;

export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('idx_audit_log_user_id').on(table.userId),
  eventTypeIdx: index('idx_audit_log_event_type').on(table.eventType),
  entityIdx: index('idx_audit_log_entity').on(table.entityType, table.entityId),
}));

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

// Relations (optional, for query convenience)
export const jobsRelations = relations(jobs, ({ many }) => ({
  plans: many(jobPlans),
  audits: many(jobAudits),
  traces: many(jobTraces),
  artifacts: many(jobArtifacts),
}));

export const jobPlansRelations = relations(jobPlans, ({ one }) => ({
  job: one(jobs, {
    fields: [jobPlans.jobId],
    references: [jobs.id],
  }),
}));

export const jobAuditsRelations = relations(jobAudits, ({ one }) => ({
  job: one(jobs, {
    fields: [jobAudits.jobId],
    references: [jobs.id],
  }),
}));

export const jobTracesRelations = relations(jobTraces, ({ one }) => ({
  job: one(jobs, {
    fields: [jobTraces.jobId],
    references: [jobs.id],
  }),
}));

export const jobArtifactsRelations = relations(jobArtifacts, ({ one }) => ({
  job: one(jobs, {
    fields: [jobArtifacts.jobId],
    references: [jobs.id],
  }),
}));

/**
 * Email verification tokens - stores verification codes for email confirmation
 */
export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: false }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: false }),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_email_tokens_user_id').on(table.userId),
  emailIdx: index('idx_email_tokens_email').on(table.email),
  codeIdx: index('idx_email_tokens_code').on(table.code),
}));

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;

/**
 * OAuth provider enum - supported OAuth providers
 * - github: GitHub OAuth for repository access
 * - google: Google OAuth for user login
 * - atlassian: Atlassian OAuth 2.0 (3LO) for Jira + Confluence
 */
export const oauthProviderEnum = pgEnum('oauth_provider', ['github', 'google', 'atlassian']);

/**
 * OAuth accounts - stores linked OAuth provider accounts
 * Links external OAuth identities to internal users
 * 
 * For Atlassian OAuth 2.0 (3LO):
 * - cloudId: Atlassian Cloud ID for API calls
 * - siteUrl: Atlassian site URL (e.g., https://your-domain.atlassian.net)
 * - scopes: Granted OAuth scopes (space-separated)
 * - refreshTokenRotatedAt: Timestamp of last refresh token rotation
 */
export const oauthAccounts = pgTable('oauth_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: oauthProviderEnum('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: false }),
  // Atlassian-specific fields (nullable for other providers)
  cloudId: varchar('cloud_id', { length: 255 }),
  siteUrl: varchar('site_url', { length: 500 }),
  scopes: text('scopes'),
  refreshTokenRotatedAt: timestamp('refresh_token_rotated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: false }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_oauth_accounts_user_id').on(table.userId),
  providerAccountIdx: index('idx_oauth_accounts_provider_account').on(table.provider, table.providerAccountId),
}));

export type OAuthAccount = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccount = typeof oauthAccounts.$inferInsert;

export const userAiKeys = pgTable('user_ai_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 50 }).notNull(),
  encryptedKey: text('encrypted_key').notNull(),
  keyIv: varchar('key_iv', { length: 64 }).notNull(),
  keyTag: varchar('key_tag', { length: 64 }).notNull(),
  keyVersion: varchar('key_version', { length: 20 }).notNull(),
  last4: varchar('last4', { length: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userProviderUnique: uniqueIndex('idx_user_ai_keys_user_provider').on(table.userId, table.provider),
  userIdIdx: index('idx_user_ai_keys_user_id').on(table.userId),
}));

export type UserAiKey = typeof userAiKeys.$inferSelect;
export type NewUserAiKey = typeof userAiKeys.$inferInsert;

// Users relations - includes oauth accounts
export const usersRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(oauthAccounts),
  profiles: many(profiles),
  conversationThreads: many(conversationThreads),
  conversationMessages: many(conversationMessages),
  threadTasks: many(threadTasks),
  planCandidates: many(planCandidates),
  planCandidateBuilds: many(planCandidateBuilds),
  threadTrustSnapshots: many(threadTrustSnapshots),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(users, {
    fields: [profiles.userId],
    references: [users.id],
  }),
  skills: many(skills),
  portfolios: many(portfolios),
  matches: many(matches),
  proposals: many(proposals),
}));

export const skillsRelations = relations(skills, ({ one }) => ({
  profile: one(profiles, {
    fields: [skills.profileId],
    references: [profiles.id],
  }),
}));

export const portfoliosRelations = relations(portfolios, ({ one }) => ({
  profile: one(profiles, {
    fields: [portfolios.profileId],
    references: [profiles.id],
  }),
}));

export const jobSourcesRelations = relations(jobSources, ({ many }) => ({
  jobPosts: many(jobPosts),
}));

export const jobPostsRelations = relations(jobPosts, ({ one, many }) => ({
  source: one(jobSources, {
    fields: [jobPosts.sourceId],
    references: [jobSources.id],
  }),
  matches: many(matches),
  proposals: many(proposals),
}));

export const matchesRelations = relations(matches, ({ one }) => ({
  profile: one(profiles, {
    fields: [matches.profileId],
    references: [profiles.id],
  }),
  jobPost: one(jobPosts, {
    fields: [matches.jobPostId],
    references: [jobPosts.id],
  }),
}));

export const proposalsRelations = relations(proposals, ({ one }) => ({
  profile: one(profiles, {
    fields: [proposals.profileId],
    references: [profiles.id],
  }),
  jobPost: one(jobPosts, {
    fields: [proposals.jobPostId],
    references: [jobPosts.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, {
    fields: [auditLog.userId],
    references: [users.id],
  }),
}));

// OAuth accounts relations
export const oauthAccountsRelations = relations(oauthAccounts, ({ one }) => ({
  user: one(users, {
    fields: [oauthAccounts.userId],
    references: [users.id],
  }),
}));

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [emailVerificationTokens.userId],
    references: [users.id],
  }),
}));

/**
 * Invite status enum — tracks invite lifecycle
 */
export const inviteStatusEnum = pgEnum('invite_status', ['pending', 'accepted', 'expired', 'revoked']);

/**
 * Invite tokens — admin-created invitations for new users
 * Token is a 64-char hex string; expires after 7 days.
 */
export const inviteTokens = pgTable('invite_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  token: varchar('token', { length: 64 }).notNull().unique(),
  email: text('email').notNull(),
  invitedBy: uuid('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: inviteStatusEnum('status').default('pending').notNull(),
  acceptedBy: uuid('accepted_by').references(() => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: false }),
  expiresAt: timestamp('expires_at', { withTimezone: false }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
}, (table) => ({
  tokenIdx: uniqueIndex('idx_invite_tokens_token').on(table.token),
  emailIdx: index('idx_invite_tokens_email').on(table.email),
  invitedByIdx: index('idx_invite_tokens_invited_by').on(table.invitedBy),
}));

export type InviteToken = typeof inviteTokens.$inferSelect;
export type NewInviteToken = typeof inviteTokens.$inferInsert;

export const inviteTokensRelations = relations(inviteTokens, ({ one }) => ({
  inviter: one(users, {
    fields: [inviteTokens.invitedBy],
    references: [users.id],
  }),
}));

/**
 * Integration provider enum for Jira/Confluence credentials
 */
export const integrationProviderEnum = pgEnum('integration_provider', ['jira', 'confluence']);

/**
 * Integration credentials - stores encrypted API tokens for Jira/Confluence
 * Uses same encryption pattern as user_ai_keys (AES-256-GCM)
 */
export const integrationCredentials = pgTable('integration_credentials', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: integrationProviderEnum('provider').notNull(),
  /** Site URL (e.g., https://your-domain.atlassian.net) */
  siteUrl: varchar('site_url', { length: 500 }).notNull(),
  /** User email for Atlassian */
  userEmail: varchar('user_email', { length: 255 }).notNull(),
  /** Encrypted API token (AES-256-GCM) */
  encryptedToken: text('encrypted_token').notNull(),
  /** IV for encryption */
  tokenIv: varchar('token_iv', { length: 64 }).notNull(),
  /** Auth tag for encryption */
  tokenTag: varchar('token_tag', { length: 64 }).notNull(),
  /** Encryption key version */
  keyVersion: varchar('key_version', { length: 20 }).notNull(),
  /** Last 4 characters of the token (for display) */
  tokenLast4: varchar('token_last4', { length: 4 }).notNull(),
  /** Last successful validation timestamp */
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  /** Whether the connection is currently valid */
  isValid: boolean('is_valid').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userProviderUnique: uniqueIndex('idx_integration_creds_user_provider').on(table.userId, table.provider),
  userIdIdx: index('idx_integration_creds_user_id').on(table.userId),
}));

export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type NewIntegrationCredential = typeof integrationCredentials.$inferInsert;

export const integrationCredentialsRelations = relations(integrationCredentials, ({ one }) => ({
  user: one(users, {
    fields: [integrationCredentials.userId],
    references: [users.id],
  }),
}));

/**
 * Agent configs - stores per-user, per-agent configuration
 * S0.4.6: Persistent Scribe configuration storage
 */
export const agentConfigs = pgTable('agent_configs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentType: varchar('agent_type', { length: 50 }).notNull(), // 'scribe', 'trace', 'proto'
  
  // Status
  enabled: boolean('enabled').notNull().default(false),
  
  // Repository settings
  repositoryOwner: varchar('repository_owner', { length: 255 }),
  repositoryName: varchar('repository_name', { length: 255 }),
  baseBranch: varchar('base_branch', { length: 255 }).default('main'),
  branchPattern: varchar('branch_pattern', { length: 255 }).default('docs/{agent}-{timestamp}'),
  
  // Target settings (JSON for flexibility)
  targetPlatform: varchar('target_platform', { length: 50 }), // 'confluence', 'notion', 'github_wiki', 'github_repo'
  targetConfig: jsonb('target_config').notNull().default({}),
  
  // Trigger settings
  triggerMode: varchar('trigger_mode', { length: 50 }).notNull().default('manual'), // 'on_pr_merge', 'scheduled', 'manual'
  scheduleCron: varchar('schedule_cron', { length: 100 }),
  
  // PR behavior
  prTitleTemplate: varchar('pr_title_template', { length: 500 }).default('docs(scribe): update {path}'),
  prBodyTemplate: text('pr_body_template'),
  autoMerge: boolean('auto_merge').notNull().default(false),
  
  // Filters
  includeGlobs: text('include_globs').array(),
  excludeGlobs: text('exclude_globs').array(),
  
  // Advanced
  jobTimeoutSeconds: integer('job_timeout_seconds').default(60),
  maxRetries: integer('max_retries').default(2),
  
  // LLM overrides (optional)
  llmModelOverride: varchar('llm_model_override', { length: 255 }),

  // Runtime controls (Agent Control Platform v1)
  runtimeProfile: varchar('runtime_profile', { length: 20 }).notNull().default('deterministic'), // deterministic|balanced|creative|custom
  temperatureValue: numeric('temperature_value', { precision: 3, scale: 2 }), // 0.00-1.00 (custom profile only)
  commandLevel: integer('command_level').notNull().default(2), // L1-L5
  allowCommandExecution: boolean('allow_command_execution').notNull().default(false), // Derived from commandLevel (>=3)
  settingsVersion: integer('settings_version').notNull().default(1),
  
  // Audit
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Unique constraint: one config per user per agent type
  userAgentUnique: uniqueIndex('idx_agent_configs_user_agent').on(table.userId, table.agentType),
  // Index for quick lookup
  userIdIdx: index('idx_agent_configs_user_id').on(table.userId),
}));

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;

export const agentConfigsRelations = relations(agentConfigs, ({ one }) => ({
  user: one(users, {
    fields: [agentConfigs.userId],
    references: [users.id],
  }),
}));

export const conversationThreadsRelations = relations(conversationThreads, ({ one, many }) => ({
  user: one(users, {
    fields: [conversationThreads.userId],
    references: [users.id],
  }),
  messages: many(conversationMessages),
  tasks: many(threadTasks),
  planCandidates: many(planCandidates),
  planCandidateBuilds: many(planCandidateBuilds),
  trustSnapshots: many(threadTrustSnapshots),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  thread: one(conversationThreads, {
    fields: [conversationMessages.threadId],
    references: [conversationThreads.id],
  }),
  user: one(users, {
    fields: [conversationMessages.userId],
    references: [users.id],
  }),
}));

export const threadTasksRelations = relations(threadTasks, ({ one }) => ({
  thread: one(conversationThreads, {
    fields: [threadTasks.threadId],
    references: [conversationThreads.id],
  }),
  user: one(users, {
    fields: [threadTasks.userId],
    references: [users.id],
  }),
}));

export const planCandidatesRelations = relations(planCandidates, ({ one, many }) => ({
  thread: one(conversationThreads, {
    fields: [planCandidates.threadId],
    references: [conversationThreads.id],
  }),
  user: one(users, {
    fields: [planCandidates.userId],
    references: [users.id],
  }),
  sourceMessage: one(conversationMessages, {
    fields: [planCandidates.sourceMessageId],
    references: [conversationMessages.id],
  }),
  buildJob: one(jobs, {
    fields: [planCandidates.buildJobId],
    references: [jobs.id],
  }),
  builds: many(planCandidateBuilds),
}));

export const planCandidateBuildsRelations = relations(planCandidateBuilds, ({ one }) => ({
  thread: one(conversationThreads, {
    fields: [planCandidateBuilds.threadId],
    references: [conversationThreads.id],
  }),
  candidate: one(planCandidates, {
    fields: [planCandidateBuilds.planCandidateId],
    references: [planCandidates.id],
  }),
  user: one(users, {
    fields: [planCandidateBuilds.userId],
    references: [users.id],
  }),
  job: one(jobs, {
    fields: [planCandidateBuilds.jobId],
    references: [jobs.id],
  }),
}));

export const threadTrustSnapshotsRelations = relations(threadTrustSnapshots, ({ one }) => ({
  thread: one(conversationThreads, {
    fields: [threadTrustSnapshots.threadId],
    references: [conversationThreads.id],
  }),
  user: one(users, {
    fields: [threadTrustSnapshots.userId],
    references: [users.id],
  }),
  job: one(jobs, {
    fields: [threadTrustSnapshots.jobId],
    references: [jobs.id],
  }),
}));

// ============================================================================
// GitHub Integration (separate from login OAuth)
// Login uses oauth_accounts; pipeline operations use this table.
// Each user must explicitly OAuth into integration even if logged in via GitHub.
// ============================================================================

export const githubIntegrations = pgTable('github_integrations', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** GitHub user numeric id */
  providerAccountId: text('provider_account_id').notNull(),
  /** GitHub username */
  login: text('login').notNull(),
  /** GitHub avatar URL */
  avatarUrl: text('avatar_url'),
  /** OAuth scopes granted (comma-separated, e.g. "read:user,user:email,repo") */
  scope: text('scope').notNull(),
  /** Encrypted OAuth access token (AES-256-GCM via OAuthTokenCrypto) */
  accessToken: text('access_token').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  loginIdx: index('idx_github_integrations_login').on(table.login),
}));

export type GithubIntegration = typeof githubIntegrations.$inferSelect;
export type NewGithubIntegration = typeof githubIntegrations.$inferInsert;

// ============================================================================
// Crew System (M2: Agent Teams — Claude Code Teams inspired)
// Enables parallel multi-agent orchestration with shared task list + messaging
// Reference: https://code.claude.com/docs/en/agent-teams
// ============================================================================

/**
 * Crew runs — top-level orchestration entity for parallel agent teams
 * Maps to Claude Code's "team lead + teammates" pattern
 */
export const crewRuns = pgTable('crew_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: crewRunStatusEnum('status').notNull().default('planning'),
  /** User's goal / task description for the crew */
  goal: text('goal').notNull(),
  /** Worker role definitions (JSON array) */
  workerRoles: jsonb('worker_roles').$type<Array<{
    role: string;
    agentType: string;
    taskDescription: string;
    color: string;
  }>>().notNull(),
  /** Coordinator job ID (the team lead) */
  coordinatorJobId: uuid('coordinator_job_id').references(() => jobs.id, { onDelete: 'set null' }),
  /** Merged output from all workers */
  mergedOutput: jsonb('merged_output'),
  /** How to merge worker outputs: concatenate, synthesize, structured */
  mergeStrategy: varchar('merge_strategy', { length: 50 }).notNull().default('synthesize'),
  /** Error handling: fail_fast (stop all on first failure) or best_effort (continue) */
  failureStrategy: varchar('failure_strategy', { length: 50 }).notNull().default('best_effort'),
  /** Auto-approve worker actions without user confirmation */
  autoApprove: boolean('auto_approve').notNull().default(false),
  totalWorkers: integer('total_workers').notNull().default(0),
  completedWorkers: integer('completed_workers').notNull().default(0),
  failedWorkers: integer('failed_workers').notNull().default(0),
  /** Coordinator reflection on merged output */
  coordinatorReflection: text('coordinator_reflection'),
  /** Aggregate token usage across all workers + coordinator */
  totalTokens: integer('total_tokens'),
  /** Aggregate cost across all workers + coordinator */
  totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_crew_runs_user_id').on(table.userId),
  statusIdx: index('idx_crew_runs_status').on(table.status),
  createdAtIdx: index('idx_crew_runs_created_at').on(table.createdAt),
}));

export type CrewRun = typeof crewRuns.$inferSelect;
export type NewCrewRun = typeof crewRuns.$inferInsert;

/**
 * Crew tasks — shared task list for agent coordination
 * Maps to Claude Code's ~/.claude/tasks/{team-name}/ pattern
 * Workers can claim tasks, track dependencies, and self-coordinate
 */
export const crewTasks = pgTable('crew_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  crewRunId: uuid('crew_run_id').notNull().references(() => crewRuns.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  status: crewTaskStatusEnum('status').notNull().default('pending'),
  /** Which worker job claimed this task (null = unclaimed) */
  assignedTo: uuid('assigned_to').references(() => jobs.id, { onDelete: 'set null' }),
  /** Task IDs this task depends on (must complete before this can start) */
  dependsOn: jsonb('depends_on').$type<string[]>().default([]),
  priority: integer('priority').notNull().default(0),
  /** Task result when completed */
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  crewRunIdIdx: index('idx_crew_tasks_crew_run_id').on(table.crewRunId),
  statusIdx: index('idx_crew_tasks_status').on(table.crewRunId, table.status),
  assignedToIdx: index('idx_crew_tasks_assigned_to').on(table.assignedTo),
}));

export type CrewTask = typeof crewTasks.$inferSelect;
export type NewCrewTask = typeof crewTasks.$inferInsert;

/**
 * Crew messages — inter-agent messaging (mailbox system)
 * Maps to Claude Code's mailbox for teammate communication
 * Enables: agent-to-agent, user-to-agent, and broadcast messages
 */
export const crewMessages = pgTable('crew_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  crewRunId: uuid('crew_run_id').notNull().references(() => crewRuns.id, { onDelete: 'cascade' }),
  /** Sender job ID (null = message from user) */
  fromJobId: uuid('from_job_id').references(() => jobs.id, { onDelete: 'set null' }),
  /** Recipient job ID (null = broadcast to all crew members) */
  toJobId: uuid('to_job_id').references(() => jobs.id, { onDelete: 'set null' }),
  /** Sender role label (e.g., 'coordinator', 'user', 'content-writer') */
  fromRole: varchar('from_role', { length: 100 }).notNull(),
  /** Recipient role label (null = broadcast) */
  toRole: varchar('to_role', { length: 100 }),
  content: text('content').notNull(),
  messageType: crewMessageTypeEnum('message_type').notNull().default('chat'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  crewRunIdIdx: index('idx_crew_messages_crew_run_id').on(table.crewRunId),
  fromJobIdIdx: index('idx_crew_messages_from_job_id').on(table.fromJobId),
  toJobIdIdx: index('idx_crew_messages_to_job_id').on(table.toJobId),
  createdAtIdx: index('idx_crew_messages_created_at').on(table.crewRunId, table.createdAt),
}));

export type CrewMessage = typeof crewMessages.$inferSelect;
export type NewCrewMessage = typeof crewMessages.$inferInsert;

// Crew relations
export const crewRunsRelations = relations(crewRuns, ({ one, many }) => ({
  user: one(users, { fields: [crewRuns.userId], references: [users.id] }),
  coordinatorJob: one(jobs, { fields: [crewRuns.coordinatorJobId], references: [jobs.id] }),
  tasks: many(crewTasks),
  messages: many(crewMessages),
}));

export const crewTasksRelations = relations(crewTasks, ({ one }) => ({
  crewRun: one(crewRuns, { fields: [crewTasks.crewRunId], references: [crewRuns.id] }),
  assignedJob: one(jobs, { fields: [crewTasks.assignedTo], references: [jobs.id] }),
}));

export const crewMessagesRelations = relations(crewMessages, ({ one }) => ({
  crewRun: one(crewRuns, { fields: [crewMessages.crewRunId], references: [crewRuns.id] }),
  fromJob: one(jobs, { fields: [crewMessages.fromJobId], references: [jobs.id] }),
  toJob: one(jobs, { fields: [crewMessages.toJobId], references: [jobs.id] }),
}));

// ============================================================================
// Knowledge Base
// ============================================================================

export const knowledgeDocStatusEnum = pgEnum('knowledge_doc_status', ['proposed', 'approved', 'deprecated']);
export const knowledgeDocTypeEnum = pgEnum('knowledge_doc_type', ['repo_doc', 'job_artifact', 'manual']);

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id'),
  projectId: uuid('project_id'),
  /** Chat-scoped ingestion (issue #463). NULL = workspace/pipeline scope; set = chat-private. */
  chatId: uuid('chat_id'),
  title: varchar('title', { length: 500 }).notNull(),
  content: text('content').notNull(),
  docType: knowledgeDocTypeEnum('doc_type').notNull(),
  sourcePath: varchar('source_path', { length: 1000 }),
  commitSha: varchar('commit_sha', { length: 40 }),
  agentType: varchar('agent_type', { length: 50 }),
  status: knowledgeDocStatusEnum('status').default('proposed').notNull(),
  version: integer('version').notNull().default(1),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index('idx_knowledge_documents_workspace').on(table.workspaceId),
  projectIdx: index('idx_knowledge_documents_project').on(table.projectId),
  chatIdx: index('idx_knowledge_documents_chat').on(table.chatId),
  statusIdx: index('idx_knowledge_documents_status').on(table.status),
  docTypeIdx: index('idx_knowledge_documents_doc_type').on(table.docType),
  agentTypeIdx: index('idx_knowledge_documents_agent_type').on(table.agentType),
}));

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocument = typeof knowledgeDocuments.$inferInsert;

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  /** Chat-scoped ingestion (issue #463). NULL = workspace/pipeline scope; set = chat-private. */
  chatId: uuid('chat_id'),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  embedding: vector1536('embedding'),
  tokenCount: integer('token_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  documentIdx: index('idx_knowledge_chunks_document').on(table.documentId),
  chunkIndexIdx: index('idx_knowledge_chunks_chunk_index').on(table.documentId, table.chunkIndex),
  // HNSW index for cosine similarity is created via raw SQL migration
  // (Drizzle doesn't support pgvector index syntax natively)
  // Partial index for chat-scoped retrieval (issue #463):
  // idx_knowledge_chunks_chat_id created via raw SQL migration 0043
}));

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;

export const knowledgeDocumentsRelations = relations(knowledgeDocuments, ({ many }) => ({
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  document: one(knowledgeDocuments, {
    fields: [knowledgeChunks.documentId],
    references: [knowledgeDocuments.id],
  }),
}));

// ============================================================================
// Knowledge Source Registry — Provenance-aware ingestion pipeline
// S0.6: Verified Knowledge Acquisition + Source Provenance
// ============================================================================

export const knowledgeSourceLicenseEnum = pgEnum('knowledge_source_license', [
  'apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'cc-by-4.0', 'cc-by-sa-4.0',
  'cc0-1.0', 'mpl-2.0', 'isc', 'unlicense', 'public-domain', 'custom-open', 'unknown',
]);

export const knowledgeSourceAccessEnum = pgEnum('knowledge_source_access', [
  'api', 'git_clone', 'http_scrape', 'rss', 'manual_upload',
]);

export const knowledgeVerificationStatusEnum = pgEnum('knowledge_verification_status', [
  'unverified', 'single_source', 'cross_verified', 'stale', 'conflicted',
]);

export const knowledgeSources = pgTable('knowledge_sources', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 300 }).notNull(),
  sourceUrl: varchar('source_url', { length: 2000 }).notNull(),
  licenseType: knowledgeSourceLicenseEnum('license_type').notNull().default('unknown'),
  accessMethod: knowledgeSourceAccessEnum('access_method').notNull(),
  domain: varchar('domain', { length: 100 }).notNull(),
  refreshIntervalHours: integer('refresh_interval_hours').default(168),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }),
  contentHash: varchar('content_hash', { length: 64 }),
  verificationStatus: knowledgeVerificationStatusEnum('verification_status').notNull().default('unverified'),
  staleAt: timestamp('stale_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  domainIdx: index('idx_knowledge_sources_domain').on(table.domain),
  activeIdx: index('idx_knowledge_sources_active').on(table.isActive),
  verificationIdx: index('idx_knowledge_sources_verification').on(table.verificationStatus),
  nextFetchIdx: index('idx_knowledge_sources_next_fetch').on(table.nextFetchAt),
}));

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type NewKnowledgeSource = typeof knowledgeSources.$inferInsert;

export const knowledgeSourcesRelations = relations(knowledgeSources, ({ many }) => ({
  provenance: many(knowledgeProvenance),
}));

/**
 * Provenance links: each knowledge chunk → source(s) that contributed it.
 * Enables citation generation and cross-source verification.
 */
export const knowledgeProvenance = pgTable('knowledge_provenance', {
  id: uuid('id').defaultRandom().primaryKey(),
  chunkId: uuid('chunk_id').notNull().references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  sourceUrl: varchar('source_url', { length: 2000 }).notNull(),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  licenseSnapshot: knowledgeSourceLicenseEnum('license_snapshot').notNull(),
  verificationStatus: knowledgeVerificationStatusEnum('verification_status').notNull().default('unverified'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  chunkIdx: index('idx_knowledge_provenance_chunk').on(table.chunkId),
  sourceIdx: index('idx_knowledge_provenance_source').on(table.sourceId),
  verificationIdx: index('idx_knowledge_provenance_verification').on(table.verificationStatus),
}));

export type KnowledgeProvenance = typeof knowledgeProvenance.$inferSelect;
export type NewKnowledgeProvenance = typeof knowledgeProvenance.$inferInsert;

export const knowledgeProvenanceRelations = relations(knowledgeProvenance, ({ one }) => ({
  chunk: one(knowledgeChunks, {
    fields: [knowledgeProvenance.chunkId],
    references: [knowledgeChunks.id],
  }),
  source: one(knowledgeSources, {
    fields: [knowledgeProvenance.sourceId],
    references: [knowledgeSources.id],
  }),
}));

/**
 * Knowledge tags: domain labels for agent-specific retrieval.
 * E.g. "react", "typescript", "devops", "testing"
 */
export const knowledgeTags = pgTable('knowledge_tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  chunkId: uuid('chunk_id').notNull().references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
  tag: varchar('tag', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  chunkIdx: index('idx_knowledge_tags_chunk').on(table.chunkId),
  tagIdx: index('idx_knowledge_tags_tag').on(table.tag),
  uniqueChunkTag: index('idx_knowledge_tags_chunk_tag').on(table.chunkId, table.tag),
}));

export type KnowledgeTag = typeof knowledgeTags.$inferSelect;
export type NewKnowledgeTag = typeof knowledgeTags.$inferInsert;

export const knowledgeTagsRelations = relations(knowledgeTags, ({ one }) => ({
  chunk: one(knowledgeChunks, {
    fields: [knowledgeTags.chunkId],
    references: [knowledgeChunks.id],
  }),
}));

/**
 * Chat-level retrieval anchors (issue #439).
 *
 * Records which knowledge chunks have been surfaced to a chat so later
 * messages in the same chat can dedupe (avoid re-surfacing) and, eventually,
 * the UI can show citation chips back-referencing the anchor.
 *
 * `chat_id` = root pipeline id (parent iteration pipelines share the same
 * chat). `message_index` is monotonic within a chat.
 */
export const chatRetrievalAnchors = pgTable('chat_retrieval_anchors', {
  id: uuid('id').defaultRandom().primaryKey(),
  chatId: uuid('chat_id').notNull(),
  chunkId: uuid('chunk_id').notNull().references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  messageIndex: integer('message_index').notNull(),
  score: real('score').notNull(),
  retrievalMethod: varchar('retrieval_method', { length: 20 }).notNull(),
  surfacedContentHash: varchar('surfaced_content_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  chatIdx: index('idx_chat_retrieval_anchors_chat').on(table.chatId, table.messageIndex),
  chunkIdx: index('idx_chat_retrieval_anchors_chunk').on(table.chunkId),
}));

export type ChatRetrievalAnchor = typeof chatRetrievalAnchors.$inferSelect;
export type NewChatRetrievalAnchor = typeof chatRetrievalAnchors.$inferInsert;

export const chatRetrievalAnchorsRelations = relations(chatRetrievalAnchors, ({ one }) => ({
  chunk: one(knowledgeChunks, {
    fields: [chatRetrievalAnchors.chunkId],
    references: [knowledgeChunks.id],
  }),
  document: one(knowledgeDocuments, {
    fields: [chatRetrievalAnchors.documentId],
    references: [knowledgeDocuments.id],
  }),
}));

/**
 * Platform feedback - pilot user feedback capture
 * S0.5.1-WL-3: Floating feedback widget for pilot demo
 */
export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  message: text('message').notNull(),
  page: varchar('page', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_feedback_user_id').on(table.userId),
  createdAtIdx: index('idx_feedback_created_at').on(table.createdAt),
}));

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;

// ============================================================================
// Pipeline System (Scribe → Proto → Trace)
// ============================================================================

export const pipelineStageEnum = pgEnum('pipeline_stage', [
  'scribe_clarifying', 'scribe_generating', 'critic_reviewing_spec',
  'awaiting_approval', 'proto_building', 'critic_reviewing_code',
  'trace_testing', 'fix_loop_iteration', 'ci_running',
  'completed', 'completed_partial', 'failed', 'cancelled',
]);

export const pipelines = pgTable('pipelines', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stage: pipelineStageEnum('stage').notNull().default('scribe_clarifying'),
  title: text('title'),
  /** AI model chosen for this chat (issue #437). Null = fall back to default. */
  model: varchar('model', { length: 255 }),
  /**
   * When set, the model is locked for this chat — `setModel` returns 409 once
   * this is non-null. Stamped at pipeline creation by startPipeline().
   */
  modelLockedAt: timestamp('model_locked_at', { withTimezone: true }),
  scribeConversation: jsonb('scribe_conversation').default([]),
  scribeOutput: jsonb('scribe_output'),
  approvedSpec: jsonb('approved_spec'),
  protoOutput: jsonb('proto_output'),
  traceOutput: jsonb('trace_output'),
  traceEnabled: boolean('trace_enabled').default(false).notNull(),
  repoContext: jsonb('repo_context'),
  protoConfig: jsonb('proto_config'),
  jiraConfig: jsonb('jira_config'),
  metrics: jsonb('metrics').default({}),
  error: jsonb('error'),
  intermediateState: jsonb('intermediate_state'),
  attemptCount: integer('attempt_count').default(0).notNull(),
  stageVersion: integer('stage_version').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('idx_pipelines_user_id').on(table.userId),
  stageIdx: index('idx_pipelines_stage').on(table.stage),
  userIdCreatedIdx: index('idx_pipelines_user_created').on(table.userId, table.createdAt),
  stageUpdatedIdx: index('idx_pipelines_stage_updated').on(table.stage, table.updatedAt),
}));

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;

// ============================================================================
// Dev Mode (Post-Pipeline Development Chat)
// ============================================================================

export const devSessionStatusEnum = pgEnum('dev_session_status', [
  'active', 'paused', 'closed',
]);

export const devChangeStatusEnum = pgEnum('dev_change_status', [
  'pending', 'approved', 'pushed', 'rejected',
]);

export const devSessions = pgTable('dev_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  pipelineId: uuid('pipeline_id').notNull().references(() => pipelines.id, { onDelete: 'cascade' }),

  // Pipeline'dan miras alınan context
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  branch: text('branch').notNull(),
  specSnapshot: jsonb('spec_snapshot'),
  initialFileTree: jsonb('initial_file_tree'),

  // Session durumu
  status: devSessionStatusEnum('status').notNull().default('active'),
  totalCommits: integer('total_commits').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pipelineIdx: index('idx_dev_sessions_pipeline').on(table.pipelineId),
}));

export const devMessages = pgTable('dev_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => devSessions.id, { onDelete: 'cascade' }),

  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),

  // Agent'ın ürettiği dosya değişiklikleri (sadece assistant mesajlarında)
  fileChanges: jsonb('file_changes'),
  changeStatus: devChangeStatusEnum('change_status'),
  commitSha: text('commit_sha'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionIdx: index('idx_dev_messages_session').on(table.sessionId),
}));

export type DevSession = typeof devSessions.$inferSelect;
export type NewDevSession = typeof devSessions.$inferInsert;
export type DevMessage = typeof devMessages.$inferSelect;

// ============================================================================
// Pipeline: Agent Activities (issue #473)
// Re-exported so Drizzle's generator includes agent_activities in migrations.
// ============================================================================
export { agentActivities } from '../pipeline/db/agent-activity-schema.js';
export type { AgentActivityInsert, AgentActivitySelect } from '../pipeline/db/agent-activity-schema.js';
export type NewDevMessage = typeof devMessages.$inferInsert;
