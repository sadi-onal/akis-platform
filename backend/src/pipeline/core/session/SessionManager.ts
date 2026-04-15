import { randomUUID } from 'node:crypto';
import type {
  SessionConfig,
  EngineerSession,
  SelectedTask,
  CompletedTask,
  SessionSummary,
} from './SessionTypes.js';
import { DEFAULT_SESSION_CONFIG } from './SessionTypes.js';

// ─── Error Helpers ──────────────────────────────

class SessionNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND';
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

class SessionValidationError extends Error {
  readonly code = 'SESSION_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'SessionValidationError';
  }
}

class SessionStateError extends Error {
  readonly code = 'SESSION_STATE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateError';
  }
}

// ─── SessionManager ─────────────────────────────

export class SessionManager {
  private sessions = new Map<string, EngineerSession>();
  private config: SessionConfig;

  constructor(config?: Partial<SessionConfig>) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
  }

  // ── Create ──────────────────────────────────────

  createSession(params: {
    userId: string;
    owner: string;
    repo: string;
    tasks: SelectedTask[];
    timeBudgetMinutes: number;
  }): EngineerSession {
    const { userId, owner, repo, tasks, timeBudgetMinutes } = params;

    if (tasks.length === 0) {
      throw new SessionValidationError('At least one task is required');
    }
    if (tasks.length > this.config.maxTasks) {
      throw new SessionValidationError(
        `Maximum ${this.config.maxTasks} tasks allowed, got ${tasks.length}`,
      );
    }
    if (timeBudgetMinutes < this.config.minTimeMinutes) {
      throw new SessionValidationError(
        `Time budget must be at least ${this.config.minTimeMinutes} minutes, got ${timeBudgetMinutes}`,
      );
    }
    if (timeBudgetMinutes > this.config.maxTimeMinutes) {
      throw new SessionValidationError(
        `Time budget must be at most ${this.config.maxTimeMinutes} minutes, got ${timeBudgetMinutes}`,
      );
    }

    const estimatedCost = timeBudgetMinutes * this.config.costPerMinute;

    const session: EngineerSession = {
      id: randomUUID(),
      userId,
      owner,
      repo,
      selectedTasks: tasks.map((t) => ({ ...t, status: 'queued' as const })),
      currentTaskIndex: 0,
      timeBudgetMinutes,
      elapsedMinutes: 0,
      totalPausedMinutes: 0,
      status: 'created',
      completedTasks: [],
      costs: { estimated: estimatedCost, actual: 0 },
      config: { ...this.config },
    };

    this.sessions.set(session.id, session);
    return session;
  }

  // ── Start ───────────────────────────────────────

  startSession(sessionId: string): EngineerSession {
    const session = this.requireSession(sessionId);

    if (session.status !== 'created') {
      throw new SessionStateError(
        `Cannot start session in status '${session.status}', expected 'created'`,
      );
    }

    const now = new Date();
    session.startedAt = now;
    session.expiresAt = new Date(now.getTime() + session.timeBudgetMinutes * 60_000);
    session.status = 'running';

    if (session.selectedTasks.length > 0) {
      session.selectedTasks[0].status = 'running';
    }

    return session;
  }

  // ── Current Task ────────────────────────────────

  getCurrentTask(sessionId: string): SelectedTask | null {
    const session = this.requireSession(sessionId);

    if (session.status !== 'running') return null;
    if (session.currentTaskIndex >= session.selectedTasks.length) return null;

    const task = session.selectedTasks[session.currentTaskIndex];
    return task.status === 'running' ? task : null;
  }

  // ── Complete Task ───────────────────────────────

  completeTask(
    sessionId: string,
    result?: { criticScore?: number; prUrl?: string; output?: Record<string, unknown> },
  ): EngineerSession {
    const session = this.requireSession(sessionId);

    if (session.status !== 'running') {
      throw new SessionStateError(`Cannot complete task: session status is '${session.status}'`);
    }

    const taskIndex = session.currentTaskIndex;
    if (taskIndex >= session.selectedTasks.length) {
      throw new SessionStateError('No more tasks to complete');
    }

    const task = session.selectedTasks[taskIndex];
    const now = new Date();

    const completed: CompletedTask = {
      ...task,
      status: 'completed',
      startedAt: this.getTaskStartTime(session, taskIndex),
      completedAt: now,
      criticScore: result?.criticScore,
      prUrl: result?.prUrl,
      output: result?.output,
    };

    session.completedTasks.push(completed);
    task.status = 'completed';
    this.updateElapsed(session);
    session.costs.actual = session.elapsedMinutes * session.config.costPerMinute;

    // Advance to next task or complete session
    const nextIndex = taskIndex + 1;
    session.currentTaskIndex = nextIndex;

    const timeInfo = this.calculateTimeRemaining(session);

    if (nextIndex >= session.selectedTasks.length) {
      session.status = 'completed';
    } else if (timeInfo.isExpired) {
      // Time expired: skip remaining tasks
      this.skipRemainingTasks(session);
      session.status = 'expired';
    } else {
      session.selectedTasks[nextIndex].status = 'running';
    }

    return session;
  }

  // ── Time Remaining ──────────────────────────────

  getTimeRemaining(sessionId: string): {
    minutes: number;
    isWarning: boolean;
    isExpired: boolean;
  } {
    const session = this.requireSession(sessionId);
    return this.calculateTimeRemaining(session);
  }

  // ── Budget ──────────────────────────────────────

  checkBudget(sessionId: string): {
    estimatedCost: number;
    actualCost: number;
    withinBudget: boolean;
  } {
    const session = this.requireSession(sessionId);
    this.updateElapsed(session);
    session.costs.actual = session.elapsedMinutes * session.config.costPerMinute;

    return {
      estimatedCost: session.costs.estimated,
      actualCost: session.costs.actual,
      withinBudget: session.costs.actual <= session.costs.estimated,
    };
  }

  // ── Pause ───────────────────────────────────────

  pauseSession(sessionId: string): EngineerSession {
    const session = this.requireSession(sessionId);

    if (session.status !== 'running') {
      throw new SessionStateError(
        `Cannot pause session in status '${session.status}', expected 'running'`,
      );
    }

    this.updateElapsed(session);
    session.pausedAt = new Date();
    session.status = 'paused';
    return session;
  }

  // ── Resume ──────────────────────────────────────

  resumeSession(sessionId: string): EngineerSession {
    const session = this.requireSession(sessionId);

    if (session.status !== 'paused') {
      throw new SessionStateError(
        `Cannot resume session in status '${session.status}', expected 'paused'`,
      );
    }

    if (session.pausedAt) {
      const pausedDuration = (Date.now() - session.pausedAt.getTime()) / 60_000;
      session.totalPausedMinutes += pausedDuration;

      // Extend expiresAt by paused duration
      if (session.expiresAt) {
        session.expiresAt = new Date(session.expiresAt.getTime() + pausedDuration * 60_000);
      }
    }

    session.pausedAt = undefined;
    session.status = 'running';
    return session;
  }

  // ── End Session ─────────────────────────────────

  endSession(sessionId: string): SessionSummary {
    const session = this.requireSession(sessionId);

    this.updateElapsed(session);
    this.skipRemainingTasks(session);

    if (session.status === 'running' || session.status === 'paused') {
      session.status = 'cancelled';
    }

    session.costs.actual = session.elapsedMinutes * session.config.costPerMinute;

    return this.buildSummary(session);
  }

  // ── Get Session ─────────────────────────────────

  getSession(sessionId: string): EngineerSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  // ─── Private Helpers ──────────────────────────────

  private requireSession(sessionId: string): EngineerSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  private updateElapsed(session: EngineerSession): void {
    if (!session.startedAt) return;

    const now = session.pausedAt ? session.pausedAt.getTime() : Date.now();
    const totalMs = now - session.startedAt.getTime();
    const totalMinutes = totalMs / 60_000;
    session.elapsedMinutes = totalMinutes - session.totalPausedMinutes;
  }

  private calculateTimeRemaining(session: EngineerSession): {
    minutes: number;
    isWarning: boolean;
    isExpired: boolean;
  } {
    if (!session.startedAt) {
      return {
        minutes: session.timeBudgetMinutes,
        isWarning: false,
        isExpired: false,
      };
    }

    this.updateElapsed(session);
    const remaining = session.timeBudgetMinutes - session.elapsedMinutes;

    return {
      minutes: Math.max(0, remaining),
      isWarning: remaining <= session.config.warningAtMinutes && remaining > 0,
      isExpired: remaining <= 0,
    };
  }

  private getTaskStartTime(session: EngineerSession, taskIndex: number): Date {
    if (taskIndex === 0 && session.startedAt) {
      return session.startedAt;
    }
    // For subsequent tasks, use the previous task's completion time
    const prevCompleted = session.completedTasks[session.completedTasks.length - 1];
    return prevCompleted ? prevCompleted.completedAt : new Date();
  }

  private skipRemainingTasks(session: EngineerSession): void {
    for (let i = session.currentTaskIndex; i < session.selectedTasks.length; i++) {
      const task = session.selectedTasks[i];
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'skipped';
      }
    }
  }

  private buildSummary(session: EngineerSession): SessionSummary {
    const completed = session.completedTasks.filter((t) => t.status === 'completed').length;
    const failed = session.completedTasks.filter((t) => t.status === 'failed').length;
    const skipped = session.selectedTasks.filter((t) => t.status === 'skipped').length;

    return {
      sessionId: session.id,
      status: session.status,
      totalTasks: session.selectedTasks.length,
      completedTasks: completed,
      failedTasks: failed,
      skippedTasks: skipped,
      totalTimeMinutes: session.elapsedMinutes,
      totalCost: session.costs.actual,
      prUrl: session.prUrl,
      taskResults: session.completedTasks,
    };
  }
}

export { SessionNotFoundError, SessionValidationError, SessionStateError };
