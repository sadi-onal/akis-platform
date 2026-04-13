import type { StructuredSpec } from './workflow';
import type { UserFriendlyPlan } from './plan';

/* ─── UI State Machine ──────────────────────────── */

export type ConversationUIState =
  | 'idle'
  | 'scribe_clarifying'
  | 'scribe_running'
  | 'awaiting_approval'
  | 'scribe_revise'
  | 'proto_running'
  | 'trace_running'
  | 'ci_running';

/* ─── Chat Mode (Plan/Act/Ask/Review) ─────────── */

export type ChatMode = 'ask' | 'plan' | 'act' | 'review';

/* ─── Chat Messages ─────────────────────────────── */

export type AgentName = 'scribe' | 'proto' | 'trace';

export type ChatMessage =
  | { type: 'user'; content: string; timestamp: string }
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
  | { type: 'pr_opened'; url: string; number: number; title: string; branch: string; filesChanged: number; linesChanged: number; timestamp: string; jiraEpicKey?: string }
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
