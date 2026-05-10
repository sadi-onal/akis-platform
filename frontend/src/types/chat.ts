import type { StructuredSpec } from './workflow';
import type { UserFriendlyPlan } from './plan';

/* ─── UI State Machine ──────────────────────────── */

export type ConversationUIState =
  | 'idle'
  | 'scribe_clarifying'
  | 'scribe_running'
  | 'critic_running'
  | 'awaiting_approval'
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
   * created from `URL.createObjectURL(file)` so it renders without re-fetching. */
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
      status: 'active' | 'edited' | 'approved' | 'rejected' | 'cancelled';
      spec?: StructuredSpec;
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

export type ConversationStatus = 'idle' | 'running' | 'awaiting_approval' | 'error';

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
