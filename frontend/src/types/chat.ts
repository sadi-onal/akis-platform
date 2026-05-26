import type { StructuredSpec } from './workflow';
import type { UserFriendlyPlan, PlanStatus } from './plan';

/**
 * Sub-step stream — chat ajan baloncuğunda collapsed listede yer alan
 * insan-dili satırlar. Backend `SubStep` ile bire bir aynı. Critic ve
 * Validator etkileri burada source ile etiketlenir; chat'te ayrı bubble
 * yok (spec DL-2/DL-3).
 */
export interface SubStep {
  label: string;
  durationMs?: number;
  status: 'done' | 'live' | 'failed';
  source?: 'critic' | 'validator' | 'agent';
}

/* ─── UI State Machine ──────────────────────────── */

export type ConversationUIState =
  | 'idle'
  | 'scribe_clarifying'
  | 'scribe_running'
  // #626: Split critic_running into spec/code so Cinema can pulse the
  // correct column. Backend emits `critic_reviewing_spec` and
  // `critic_reviewing_code` as distinct stage_change events; collapsing
  // them into one `critic_running` lost the phase information that Cinema
  // needs to decide Scribe-pulse vs Proto-pulse.
  | 'critic_reviewing_spec'
  | 'critic_reviewing_code'
  | 'awaiting_approval'
  | 'awaiting_push_confirm'
  // P8 — Critic hard-block: pipeline waits for user to fix or override.
  | 'awaiting_critic_resolution'
  | 'scribe_revise'
  | 'proto_running'
  | 'trace_running'
  | 'ci_running';

/* ─── Chat Mode (Plan/Act/Ask/Review) ─────────── */

export type ChatMode = 'ask' | 'plan' | 'act' | 'review';

/* ─── Chat Messages ─────────────────────────────── */

export type AgentName = 'scribe' | 'proto' | 'trace';

/**
 * Thumbnail metadata for an image attached to a user chat message.
 * Populated on the client from the original `ChatAttachment` so the message
 * bubble can render a preview inline, and optionally opened full-size in a
 * modal on click. Issue #464 BUG-C.
 */
export interface UserMessageImage {
  /** Stable id per attachment — reused from the input's attachment id. */
  id: string;
  /** Original filename for alt text + modal caption. */
  name: string;
  /** URL usable by <img src>. In the current client this is the blob URL
   * created from `URL.createObjectURL(file)` so it renders without re-fetching.
   * TODO(L-17): If attachment creation is re-enabled, ensure blob URLs are
   * revoked (URL.revokeObjectURL) when messages leave the viewport or the
   * conversation unmounts to prevent memory leaks. */
  previewUrl: string;
  /** MIME type (kept for future format-specific rendering). */
  mimeType: string;
}

export type ChatMessage =
  | {
      type: 'user';
      content: string;
      timestamp: string;
      /** User-attached images, rendered as thumbnail grid below the text. */
      images?: UserMessageImage[];
    }
  | {
      type: 'agent';
      agent: AgentName;
      content: string;
      timestamp: string;
      activityEntryId?: string;
      jiraEpicKey?: string;
      /**
       * Chat event-log (2026-05-22) — surfaces the iteration counter when the
       * message originated from a `proto_completed` / `trace_completed`
       * event-log entry. Older snapshot-derived messages omit this.
       */
      iteration?: number;
      /**
       * Proto F-6 (2026-05-22): when this row comes from a Proto stage
       * (`proto_completed` event or proto_result snapshot), `summary` carries
       * the LLM-generated Turkish narration ("Sayaç için React projesi
       * hazırladım…") and the renderer leads with it. `content` becomes a
       * fallback for legacy pipelines without `protoOutput.summary`.
       * Metadata fields (totalFiles/totalLines/branch) render as a smaller
       * secondary line beneath the summary. All optional — non-Proto rows
       * (Scribe/Trace narrators) omit them.
       */
      summary?: string;
      totalFiles?: number;
      totalLines?: number;
      branch?: string;
      /**
       * Chat agent narrator (2026-05-23) — yeni field'lar:
       * - isLive: çalışmakta olan ajan baloncuğu mu?
       * - liveLabel: italic narrator metni ("Acceptance criteria yazıyor")
       * - startedAt: useRelativeDuration için
       * - durationMs: completed duration (server-truth)
       * - subSteps: collapsed sub-step listesi
       * - embeddedPlan: sadece Scribe son tur'da plan kartı için
       */
      isLive?: boolean;
      liveLabel?: string;
      startedAt?: string;
      durationMs?: number;
      subSteps?: SubStep[];
      embeddedPlan?: {
        plan: UserFriendlyPlan;
        version: number;
        status: PlanStatus;
        spec?: StructuredSpec;
        assumptions?: string[];
      };
    }
  | {
      type: 'clarification';
      role: AgentName;
      content: string;
      questions: Array<{ id: string; question: string; reason: string; suggestions?: string[] }>;
      timestamp: string;
    }
  | {
      type: 'plan';
      plan: UserFriendlyPlan;
      version: number;
      status: PlanStatus;
      spec?: StructuredSpec;
      /**
       * PR-V6 — Scribe assumptions surfaced alongside the structured spec so
       * the PlanCard can render them as a `<details>` disclosure. Optional
       * since older conversation rows + change-plan messages don't carry it.
       */
      assumptions?: string[];
      timestamp: string;
    }
  | { type: 'file_created'; path: string; repo: string; timestamp: string }
  | {
      type: 'pr_opened';
      url: string;
      number: number;
      title: string;
      branch: string;
      filesChanged: number;
      linesChanged: number;
      timestamp: string;
      jiraEpicKey?: string;
    }
  | {
      type: 'test_result';
      passed: number;
      failed: number;
      total: number;
      coverage: string;
      failures?: TestFailure[];
      testFiles?: Array<{ filePath: string; testCount: number }>;
      coverageMatrix?: Record<string, string[]>;
      coveredCriteria?: string[];
      uncoveredCriteria?: string[];
      timestamp: string;
      jiraEpicKey?: string;
      /** Iteration counter from event-log `trace_completed` (2026-05-22). */
      iteration?: number;
      /**
       * Chat narrator (2026-05-23) — Trace `trace_completed` event-log payload
       * carries an LLM Turkish summary, a server-truth `durationMs`, and a
       * sub-step disclosure list. The renderer (ChatMessage `test_result` case)
       * surfaces these alongside the numeric pass/fail/coverage block — when
       * missing the existing pipeline header keeps its old shape.
       */
      summary?: string;
      durationMs?: number;
      subSteps?: SubStep[];
      /**
       * Real test execution results from TraceAutomationRunner.
       * When present, the UI renders an additional "Actual Results" section
       * separate from the AI-estimated figures above.
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
  | {
      type: 'error';
      agent: string;
      message: string;
      retryable: boolean;
      timestamp: string;
      code?: string;
      recoveryAction?: string;
      retryCount?: number;
      maxRetries?: number;
    }
  | { type: 'info'; content: string; timestamp: string }
  | {
      /**
       * Claude-Code-style "Background agent started/running/finished" marker
       * inserted into the chat timeline on each stage transition.
       * Issue #390 / BUG-10 MVP.
       */
      type: 'agent_started';
      agent: AgentName;
      task?: string;
      state: 'started' | 'running' | 'completed';
      meta?: string;
      timestamp: string;
    }
  | {
      type: 'pipeline_complete';
      status: 'completed' | 'completed_partial';
      repoUrl: string;
      branch: string;
      fileCount: number;
      lineCount: number;
      testCount?: number;
      coverage?: string;
      cloneCommand: string;
      setupCommands?: string[];
      timestamp: string;
    }
  | {
      type: 'critic_review';
      reviewType: 'spec_review' | 'code_review';
      approved: boolean;
      score: number;
      findings: Array<{
        severity: 'critical' | 'major' | 'minor' | 'info';
        category: string;
        description: string;
        suggestion: string;
      }>;
      summary: string;
      timestamp: string;
    }
  | {
      /**
       * Chat Q&A response (FR-10). Pipeline-free — does NOT trigger a build.
       * `streaming=true` while tokens are arriving via SSE; flips to false on
       * the `done` event. `needsBuild=true` renders a "[BUILD]" suggestion CTA.
       */
      type: 'chat_qa_response';
      content: string;
      citations?: Array<{ source: string; excerpt: string; refKey?: string }>;
      needsBuild?: boolean;
      streaming?: boolean;
      /** The original user question — surfaced for the optional [BUILD] CTA. */
      sourceMessage?: string;
      timestamp: string;
    }
  | {
      /**
       * Chat event-log (2026-05-22) — Trace stage failed during this
       * iteration. Distinguishes from generic `error` ChatMessage so
       * downstream components (TraceFailureMessage in T8) can render
       * iteration-aware retry/skip controls.
       */
      type: 'trace_failure';
      errorCode: string;
      errorMessage: string;
      recoveryAction?: 'retry' | 'skip';
      iteration?: number;
      timestamp: string;
    }
  | {
      type: 'gherkin_spec';
      features: Array<{
        featureName: string;
        filePath: string;
        content: string;
        scenarioCount: number;
        mappedCriteria: string[];
      }>;
      totalScenarios: number;
      timestamp: string;
    };

export interface TestFailure {
  file: string;
  line: number;
  message: string;
}

/* ─── Conversation List Item ────────────────────── */

// PR-U2 #2: `partial` added so the sidebar can surface `completed_partial`
// pipelines distinctly from `idle` (success). Pre-fix users saw a green
// "Hazır" pill for partial runs — looked identical to a clean success.
export type ConversationStatus = 'idle' | 'running' | 'awaiting_approval' | 'partial' | 'error';

export interface ConversationListItem {
  id: string;
  title: string;
  repoFullName: string;
  repoShortName: string;
  status: ConversationStatus;
  fileCount: number;
  lastActivity: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
}

/* ─── Agent Audit ───────────────────────────────── */

export interface AgentAuditMetrics {
  confidence?: number;
  assumptions?: string[];
  tokenUsage: { inputTokens: number; outputTokens: number };
  responseTime: number;
  filesGenerated?: number;
  testsPassed?: number;
  testsFailed?: number;
  specCompliance?: number;
}
