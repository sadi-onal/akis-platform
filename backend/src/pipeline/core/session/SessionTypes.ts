// ─── Configuration ──────────────────────────────

export interface SessionConfig {
  maxTasks: number;
  minTimeMinutes: number;
  maxTimeMinutes: number;
  costPerMinute: number;
  warningAtMinutes: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxTasks: 5,
  minTimeMinutes: 30,
  maxTimeMinutes: 180,
  costPerMinute: 0.0167,
  warningAtMinutes: 5,
};

// ─── Status Types ───────────────────────────────

export type SessionStatus = 'created' | 'running' | 'paused' | 'completed' | 'cancelled' | 'expired';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'skipped' | 'failed';

// ─── Task Types ─────────────────────────────────

export interface SelectedTask {
  taskId: string;
  title: string;
  category: string;
  estimatedMinutes: number;
  status: TaskStatus;
  /**
   * Optional human-readable description from TaskDiscoveryService. Propagated
   * through the session so EngineerSessionRunner can feed it to Scribe as
   * richer context than the title alone.
   */
  description?: string;
}

export interface CompletedTask extends SelectedTask {
  status: 'completed' | 'failed';
  startedAt: Date;
  completedAt: Date;
  criticScore?: number;
  prUrl?: string;
  output?: Record<string, unknown>;
}

// ─── Session ────────────────────────────────────

export interface EngineerSession {
  id: string;
  pipelineId?: string;
  userId: string;
  owner: string;
  repo: string;
  selectedTasks: SelectedTask[];
  currentTaskIndex: number;
  timeBudgetMinutes: number;
  startedAt?: Date;
  pausedAt?: Date;
  expiresAt?: Date;
  elapsedMinutes: number;
  totalPausedMinutes: number;
  status: SessionStatus;
  completedTasks: CompletedTask[];
  prUrl?: string;
  costs: { estimated: number; actual: number };
  config: SessionConfig;
}

// ─── Summary ────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  totalTimeMinutes: number;
  totalCost: number;
  prUrl?: string;
  taskResults: CompletedTask[];
}
