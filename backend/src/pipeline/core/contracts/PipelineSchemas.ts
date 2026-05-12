import { z } from 'zod';

// ─── SCRIBE SCHEMAS ───────────────────────────────

export const ScribeInputSchema = z.object({
  idea: z.string().min(10, 'Fikir en az 10 karakter olmalı').max(10000, 'Fikir en fazla 10.000 karakter olabilir'),
  context: z.string().max(5000).optional(),
  targetStack: z.string().max(200).optional(),
  existingRepo: z
    .object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      branch: z.string().min(1),
    })
    .optional(),
});

export const ScribeClarificationSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(1),
        reason: z.string().min(1),
        suggestions: z.array(z.string()).optional(),
      })
    )
    .min(1)
    .max(4),
});

export const StructuredSpecSchema = z.object({
  title: z.string().min(3),
  problemStatement: z.string().min(10),
  userStories: z
    .array(
      z.object({
        persona: z.string().min(1),
        action: z.string().min(1),
        benefit: z.string().min(1),
      })
    )
    .min(1),
  acceptanceCriteria: z
    .array(
      z.object({
        id: z.string().min(1),
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
      })
    )
    .min(1),
  technicalConstraints: z.object({
    stack: z.string().optional(),
    integrations: z.array(z.string()).optional(),
    nonFunctional: z.array(z.string()).optional(),
  }),
  outOfScope: z.array(z.string()),
});

export const ReviewNotesSchema = z.union([
  z.string(),
  z.object({
    selfReviewPassed: z.boolean().optional(),
    revisionsApplied: z.array(z.string()).optional(),
    assumptionsMade: z.array(z.string()).optional(),
  }),
]).optional();

export const UserFriendlyPlanSchema = z.object({
  projectName: z.string().min(1),
  summary: z.string().min(1),
  features: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
  })).min(1),
  techChoices: z.array(z.string()),
  estimatedFiles: z.number().int().min(1),
  requiresTests: z.boolean(),
  testRationale: z.string().optional(),
});

export const ScribeOutputSchema = z.object({
  spec: StructuredSpecSchema,
  plan: UserFriendlyPlanSchema,
  rawMarkdown: z.string().min(1),
  confidence: z.number().min(0).max(1),
  clarificationsAsked: z.number().int().min(0).max(3),
  reviewNotes: ReviewNotesSchema,
  assumptions: z.array(z.string()).optional(),
});

export const ScribeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_idea'), content: z.string().min(1) }),
  z.object({ type: z.literal('clarification'), content: ScribeClarificationSchema }),
  z.object({ type: z.literal('user_answer'), content: z.string().min(1) }),
  z.object({ type: z.literal('spec_draft'), content: ScribeOutputSchema }),
  z.object({ type: z.literal('spec_approved'), content: StructuredSpecSchema }),
  z.object({
    type: z.literal('spec_rejected'),
    content: z.object({ feedback: z.string().min(1) }),
  }),
]);

// ─── PROTO SCHEMAS ────────────────────────────────

export const ProtoInputSchema = z.object({
  spec: StructuredSpecSchema,
  repoName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Repo adı geçersiz karakterler içeriyor'),
  repoVisibility: z.enum(['public', 'private']),
  owner: z.string().min(1),
  baseBranch: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export const ProtoFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  linesOfCode: z.number().int().min(0),
});

export const ProtoOutputSchema = z.object({
  ok: z.boolean(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  repoUrl: z.string().url(),
  files: z.array(ProtoFileSchema).min(1),
  prUrl: z.string().url().optional(),
  setupCommands: z.array(z.string()).min(1),
  metadata: z.object({
    filesCreated: z.number().int().min(0),
    totalLinesOfCode: z.number().int().min(0),
    stackUsed: z.string().min(1),
    committed: z.boolean(),
  }),
});

// ─── TRACE SCHEMAS ────────────────────────────────

export const TraceInputSchema = z.object({
  repoOwner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  spec: StructuredSpecSchema.optional(),
  dryRun: z.boolean().optional(),
});

export const TraceTestFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string().min(1),
  testCount: z.number().int().min(1),
});

export const TraceOutputSchema = z.object({
  ok: z.boolean(),
  testFiles: z.array(TraceTestFileSchema).min(1),
  coverageMatrix: z.record(z.string(), z.array(z.string())),
  testSummary: z.object({
    totalTests: z.number().int().min(0),
    coveragePercentage: z.number().min(0).max(100),
    coveredCriteria: z.array(z.string()),
    uncoveredCriteria: z.array(z.string()),
  }),
  branch: z.string().optional(),
  prUrl: z.string().url().optional(),
});

// ─── PIPELINE SCHEMAS ─────────────────────────────

export const PipelineStageSchema = z.enum([
  'scribe_clarifying',
  'scribe_generating',
  'critic_reviewing_spec',
  'awaiting_approval',
  'proto_building',
  'critic_reviewing_code',
  'awaiting_push_confirm',
  'trace_testing',
  'fix_loop_iteration',
  'ci_running',
  'completed',
  'completed_partial',
  'failed',
  'cancelled',
]);

export const PipelineErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  technicalDetail: z.string().optional(),
  retryable: z.boolean(),
  recoveryAction: z.enum(['retry', 'edit_spec', 'reconnect_github', 'start_over', 'configure_ai_key']).optional(),
});

export const PipelineMetricsSchema = z.object({
  startedAt: z.coerce.date(),
  scribeCompletedAt: z.coerce.date().optional(),
  approvedAt: z.coerce.date().optional(),
  protoCompletedAt: z.coerce.date().optional(),
  traceCompletedAt: z.coerce.date().optional(),
  totalDurationMs: z.number().int().min(0).optional(),
  clarificationRounds: z.number().int().min(0).max(3),
  retryCount: z.number().int().min(0),
  estimatedCost: z.number().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  totalTokens: z.number().int().min(0).optional(),
});

export const JiraConfigSchema = z.object({
  projectKey: z.string().min(1).max(20).regex(/^[A-Z][A-Z0-9_]*$/, 'Jira proje anahtarı geçersiz'),
  enabled: z.boolean(),
  epicKey: z.string().optional(),
}).optional();

export const PipelineStateSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  stage: PipelineStageSchema,
  title: z.string().optional(),

  scribeConversation: z.array(ScribeMessageSchema),
  scribeOutput: ScribeOutputSchema.optional(),
  approvedSpec: StructuredSpecSchema.optional(),
  protoOutput: ProtoOutputSchema.optional(),
  traceOutput: TraceOutputSchema.optional(),
  protoConfig: z.object({
    repoName: z.string().min(1),
    repoVisibility: z.enum(['public', 'private']),
  }).optional(),
  jiraConfig: JiraConfigSchema,

  metrics: PipelineMetricsSchema,
  error: PipelineErrorSchema.optional(),

  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ─── PIPELINE API REQUEST SCHEMAS ─────────────────

export const StartPipelineRequestSchema = z.object({
  idea: z.string().min(10, 'Fikir en az 10 karakter olmalı').max(10000, 'Fikir en fazla 10.000 karakter olabilir'),
  context: z.string().max(5000).optional(),
  targetStack: z.string().max(200).optional(),
  existingRepo: z
    .object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      branch: z.string().min(1),
    })
    .optional(),
  parentPipelineId: z.string().uuid().optional(),
  /** When true, skip Scribe and jump directly to Proto (iteration on existing project) */
  skipScribe: z.boolean().optional().default(false),
  /** When true, run Trace (test generation) after Proto. Default: true (user can opt out). */
  traceEnabled: z.boolean().optional().default(true),
  /**
   * Preferred AI model for this pipeline. Validated downstream via
   * `isModelAllowed` + `isModelCompatibleWithProvider` so the per-chat
   * model picker (issue #437) can send any provider's model ID.
   */
  model: z.string().min(1).max(255).optional().default('claude-haiku-4-5'),
  jiraConfig: JiraConfigSchema,
});

export const SendMessageRequestSchema = z.object({
  message: z.string().min(1, 'Mesaj boş olamaz').max(5000),
});

export const ApproveSpecRequestSchema = z.object({
  spec: StructuredSpecSchema.optional(),
  repoName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Repo adı geçersiz karakterler içeriyor'),
  repoVisibility: z.enum(['public', 'private']).default('private'),
  jiraConfig: JiraConfigSchema,
  cucumberEnabled: z.boolean().optional().default(false),
});

export const RejectSpecRequestSchema = z.object({
  feedback: z.string().min(1, 'Feedback boş olamaz').max(2000),
});
