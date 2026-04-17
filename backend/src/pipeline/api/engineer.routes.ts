/**
 * Engineer Rental Mode routes — wired to real TaskDiscoveryService + SessionManager.
 *
 * Routes:
 *   POST   /api/engineer/discover            → Discover tasks in a repo
 *   POST   /api/engineer/session             → Create engineer session
 *   POST   /api/engineer/session/:id/start   → Start session timer
 *   GET    /api/engineer/session/:id         → Get session status
 *   GET    /api/engineer/session/:id/progress → Get current progress
 *   POST   /api/engineer/session/:id/pause   → Pause session
 *   POST   /api/engineer/session/:id/resume  → Resume session
 *   POST   /api/engineer/session/:id/cancel  → Cancel session
 *   GET    /api/engineer/session/:id/report  → Final session report
 */

import type { TaskDiscoveryService } from '../core/task-discovery/index.js';
import type { DiscoveredTask as RealDiscoveredTask } from '../core/task-discovery/index.js';
import {
  SessionManager,
  SessionNotFoundError,
  SessionValidationError,
  SessionStateError,
} from '../core/session/index.js';
import type { SelectedTask, EngineerSession as RealSession } from '../core/session/index.js';
import type { EngineerSessionRunner } from '../core/session/EngineerSessionRunner.js';
import type { GitHubServiceLike } from '../core/pipeline-factory.js';
import { logger } from '../../lib/logger.js';

// ─── Request Types ──────────────────────────────────

export interface DiscoverBody {
  owner: string;
  repo: string;
  hint?: string;
}

export interface CreateSessionBody {
  owner: string;
  repo: string;
  selectedTaskIds: string[];
  timeBudgetMinutes: number;
}

// ─── Response Types (API contract for frontend) ─────

export interface DiscoveredTaskResponse {
  id: string;
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'docs' | 'security' | 'test' | 'refactor';
  estimatedMinutes: number;
  complexity: 1 | 2 | 3;
  affectedFiles: string[];
  priority: string;
}

export type SessionStatusResponse =
  | 'created' | 'running' | 'paused' | 'completed' | 'cancelled' | 'expired';

export interface SessionTaskResponse {
  id: string;
  title: string;
  category: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  criticScore: number | null;
  timeSpentSeconds: number;
  /** Human-readable description from TaskDiscoveryService, if the task had one. */
  description?: string;
}

export interface SessionResponse {
  id: string;
  owner: string;
  repo: string;
  status: SessionStatusResponse;
  tasks: SessionTaskResponse[];
  timeBudgetMinutes: number;
  timeRemainingSeconds: number;
  startedAt: string | null;
  createdAt: string;
}

export interface SessionProgressResponse {
  sessionId: string;
  status: SessionStatusResponse;
  currentTask: SessionTaskResponse | null;
  completedTasks: SessionTaskResponse[];
  queuedTasks: SessionTaskResponse[];
  timeRemainingSeconds: number;
  elapsedSeconds: number;
}

export interface SessionReportResponse {
  sessionId: string;
  owner: string;
  repo: string;
  status: 'completed' | 'cancelled' | 'expired';
  tasks: Array<SessionTaskResponse & { description: string }>;
  totalTimeSeconds: number;
  totalCost: number;
  prUrl: string | null;
  completedAt: string;
}

// ─── Route Dependencies ─────────────────────────────

export interface EngineerRouteDeps {
  getUserId: (request: unknown) => string;
  taskDiscovery: TaskDiscoveryService;
  sessionManager: SessionManager;
  githubService: GitHubServiceLike;
  /**
   * Optional per-factory cache for discovered tasks. Injected in tests so
   * behaviour can be observed; in production `createEngineerRoutes` builds
   * its own Map so two engineer plugins in the same process do not share
   * state.
   */
  taskCache?: Map<string, RealDiscoveredTask[]>;
  /**
   * Optional session runner — when present, /session/:id/start also kicks
   * off the actual Scribe→Proto→Trace pipeline per queued task in the
   * background. Omitted in unit tests that only exercise the HTTP layer.
   */
  sessionRunner?: EngineerSessionRunner;
}

// ─── Helpers ────────────────────────────────────────

function complexityToNumber(c: string): 1 | 2 | 3 {
  if (c === 'simple') return 1;
  if (c === 'complex') return 3;
  return 2; // 'moderate' or default
}

function mapDiscoveredTask(t: RealDiscoveredTask): DiscoveredTaskResponse {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    category: t.category,
    estimatedMinutes: t.estimatedMinutes,
    complexity: complexityToNumber(t.complexity),
    affectedFiles: t.affectedFiles,
    priority: t.priority,
  };
}

function mapSessionToResponse(session: RealSession, timeRemainingSeconds: number): SessionResponse {
  return {
    id: session.id,
    owner: session.owner,
    repo: session.repo,
    status: session.status,
    tasks: session.selectedTasks.map((t) => ({
      id: t.taskId,
      title: t.title,
      category: t.category,
      status: t.status === 'running' ? 'running' as const : t.status,
      criticScore: session.completedTasks.find((c) => c.taskId === t.taskId)?.criticScore ?? null,
      timeSpentSeconds: (() => {
        const completed = session.completedTasks.find((c) => c.taskId === t.taskId);
        if (!completed) return 0;
        return Math.floor((completed.completedAt.getTime() - completed.startedAt.getTime()) / 1000);
      })(),
      description: t.description,
    })),
    timeBudgetMinutes: session.timeBudgetMinutes,
    timeRemainingSeconds: Math.floor(timeRemainingSeconds * 60),
    startedAt: session.startedAt?.toISOString() ?? null,
    createdAt: session.startedAt?.toISOString() ?? new Date().toISOString(),
  };
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

// ─── Route Creators ─────────────────────────────────

export function createEngineerRoutes(deps: EngineerRouteDeps) {
  const { getUserId, taskDiscovery, sessionManager, githubService, sessionRunner } = deps;

  // Per-factory cache: discover writes, createSession reads-and-deletes.
  // Kept inside the closure (not at module scope) so each engineer plugin
  // instance has its own state and long-running processes don't accumulate
  // stale entries for users who never reached createSession.
  const discoveredTasksCache = deps.taskCache ?? new Map<string, RealDiscoveredTask[]>();

  /**
   * Ownership gate — returns 404 (not 403) when the session exists but
   * belongs to someone else, matching how /pipelines handles the same
   * concern and preventing probe-by-ID info leaks.
   */
  function assertSessionOwnership(request: unknown, sessionId: string): void {
    const userId = getUserId(request);
    const session = sessionManager.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw httpError('Oturum bulunamadi', 404);
    }
  }

  return {
    /** POST /discover — Analyze repo and discover tasks */
    async discover(request: unknown) {
      const userId = getUserId(request);
      const body = (request as { body: DiscoverBody }).body;

      if (!body.owner || !body.repo) {
        throw httpError('owner ve repo alanlari zorunludur', 400);
      }

      // Fetch repo file listing via GitHub
      let files: Array<{ path: string; content?: string }> = [];
      let readme: string | undefined;
      let packageJson: Record<string, unknown> | undefined;

      try {
        const filePaths = await githubService.listFiles(body.owner, body.repo, 'main');
        files = filePaths.map((p) => ({ path: p }));

        // Fetch README if it exists
        const readmePath = filePaths.find((p) =>
          p.toLowerCase() === 'readme.md' || p.toLowerCase() === 'readme.txt',
        );
        if (readmePath) {
          try {
            readme = await githubService.getFileContent(body.owner, body.repo, 'main', readmePath);
          } catch { /* ignore */ }
        }

        // Fetch package.json if it exists
        const pkgPath = filePaths.find((p) => p === 'package.json');
        if (pkgPath) {
          try {
            const raw = await githubService.getFileContent(body.owner, body.repo, 'main', pkgPath);
            packageJson = JSON.parse(raw) as Record<string, unknown>;
          } catch { /* ignore */ }
        }
      } catch {
        // If GitHub is not configured or fails, use empty context
        files = [];
      }

      const result = await taskDiscovery.discoverTasks({
        repoContext: { owner: body.owner, repo: body.repo, files, readme, packageJson },
        userHint: body.hint,
        maxTasks: 10,
      });

      // Cache tasks for session creation
      const cacheKey = `${userId}:${body.owner}/${body.repo}`;
      discoveredTasksCache.set(cacheKey, result.tasks);

      return {
        owner: body.owner,
        repo: body.repo,
        tasks: result.tasks.map(mapDiscoveredTask),
        repoHealth: result.repoHealth,
        suggestedPlan: result.suggestedPlan,
        analyzedAt: new Date().toISOString(),
      };
    },

    /** POST /session — Create a new engineer session */
    async createSession(request: unknown) {
      const userId = getUserId(request);
      const body = (request as { body: CreateSessionBody }).body;

      if (!body.owner || !body.repo) {
        throw httpError('owner ve repo alanlari zorunludur', 400);
      }
      if (!body.selectedTaskIds?.length) {
        throw httpError('En az bir gorev secilmelidir', 400);
      }
      if (body.selectedTaskIds.length > 5) {
        throw httpError('En fazla 5 gorev secilebilir', 400);
      }

      // Look up discovered tasks from cache
      const cacheKey = `${userId}:${body.owner}/${body.repo}`;
      const cachedTasks = discoveredTasksCache.get(cacheKey) ?? [];

      const selectedTasks: SelectedTask[] = body.selectedTaskIds.map((taskId) => {
        const discovered = cachedTasks.find((t) => t.id === taskId);
        return {
          taskId,
          title: discovered?.title ?? `Gorev ${taskId}`,
          category: discovered?.category ?? 'feature',
          estimatedMinutes: discovered?.estimatedMinutes ?? 15,
          status: 'queued' as const,
          // Description flows through the session so EngineerSessionRunner's
          // taskToScribeInput mapper can hand Scribe more than just a title.
          description: discovered?.description,
        };
      });

      try {
        const session = sessionManager.createSession({
          userId,
          owner: body.owner,
          repo: body.repo,
          tasks: selectedTasks,
          timeBudgetMinutes: body.timeBudgetMinutes,
        });

        // Discovered tasks have been frozen into the session — drop the
        // cache entry so idle discover→no-session flows do not accumulate.
        discoveredTasksCache.delete(cacheKey);

        const timeInfo = sessionManager.getTimeRemaining(session.id);
        return { session: mapSessionToResponse(session, timeInfo.minutes) };
      } catch (err) {
        if (err instanceof SessionValidationError) {
          throw httpError(err.message, 400);
        }
        throw err;
      }
    },

    /** POST /session/:id/start — Start session timer and trigger pipeline runs */
    async startSession(request: unknown) {
      const userId = getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      try {
        const session = sessionManager.startSession(id);

        // Kick off the actual pipeline work in the background. The runner
        // observes that the session is already 'running' and skips its own
        // startSession call, then drives each task to a terminal stage.
        if (sessionRunner) {
          sessionRunner.run(id, userId).catch((err) => {
            logger.error({ err, sessionId: id, userId }, '[engineer.startSession] runner.run rejected');
          });
        }

        const timeInfo = sessionManager.getTimeRemaining(id);
        return { session: mapSessionToResponse(session, timeInfo.minutes) };
      } catch (err) {
        if (err instanceof SessionNotFoundError) throw httpError('Oturum bulunamadi', 404);
        if (err instanceof SessionStateError) throw httpError(err.message, 400);
        throw err;
      }
    },

    /** GET /session/:id — Get session status */
    async getSession(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      const session = sessionManager.getSession(id);
      if (!session) throw httpError('Oturum bulunamadi', 404);

      const timeInfo = sessionManager.getTimeRemaining(id);
      return { session: mapSessionToResponse(session, timeInfo.minutes) };
    },

    /** GET /session/:id/progress — Current task + time remaining */
    async getProgress(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      const session = sessionManager.getSession(id);
      if (!session) throw httpError('Oturum bulunamadi', 404);

      const currentTask = sessionManager.getCurrentTask(id);
      const timeInfo = sessionManager.getTimeRemaining(id);

      const completedTasks = session.selectedTasks.filter((t) => t.status === 'completed');
      const queuedTasks = session.selectedTasks.filter((t) => t.status === 'queued');

      const elapsedMinutes = session.elapsedMinutes;
      const timeRemainingSeconds = Math.floor(timeInfo.minutes * 60);

      const progress: SessionProgressResponse = {
        sessionId: id,
        status: session.status,
        currentTask: currentTask ? {
          id: currentTask.taskId,
          title: currentTask.title,
          category: currentTask.category,
          status: 'running',
          criticScore: null,
          timeSpentSeconds: 0,
          description: currentTask.description,
        } : null,
        completedTasks: completedTasks.map((t) => ({
          id: t.taskId,
          title: t.title,
          category: t.category,
          status: 'completed' as const,
          criticScore: session.completedTasks.find((c) => c.taskId === t.taskId)?.criticScore ?? null,
          timeSpentSeconds: (() => {
            const c = session.completedTasks.find((ct) => ct.taskId === t.taskId);
            if (!c) return 0;
            return Math.floor((c.completedAt.getTime() - c.startedAt.getTime()) / 1000);
          })(),
          description: t.description,
        })),
        queuedTasks: queuedTasks.map((t) => ({
          id: t.taskId,
          title: t.title,
          category: t.category,
          status: 'queued' as const,
          criticScore: null,
          timeSpentSeconds: 0,
          description: t.description,
        })),
        timeRemainingSeconds,
        elapsedSeconds: Math.floor(elapsedMinutes * 60),
      };

      return { progress };
    },

    /** POST /session/:id/pause — Pause session */
    async pauseSession(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      try {
        const session = sessionManager.pauseSession(id);
        const timeInfo = sessionManager.getTimeRemaining(id);
        return { session: mapSessionToResponse(session, timeInfo.minutes) };
      } catch (err) {
        if (err instanceof SessionNotFoundError) throw httpError('Oturum bulunamadi', 404);
        if (err instanceof SessionStateError) throw httpError(err.message, 400);
        throw err;
      }
    },

    /** POST /session/:id/resume — Resume session */
    async resumeSession(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      try {
        const session = sessionManager.resumeSession(id);
        const timeInfo = sessionManager.getTimeRemaining(id);
        return { session: mapSessionToResponse(session, timeInfo.minutes) };
      } catch (err) {
        if (err instanceof SessionNotFoundError) throw httpError('Oturum bulunamadi', 404);
        if (err instanceof SessionStateError) throw httpError(err.message, 400);
        throw err;
      }
    },

    /** POST /session/:id/cancel — Cancel session */
    async cancelSession(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      try {
        const summary = sessionManager.endSession(id);
        return {
          session: {
            id: summary.sessionId,
            status: summary.status,
            totalTasks: summary.totalTasks,
            completedTasks: summary.completedTasks,
            skippedTasks: summary.skippedTasks,
            totalTimeMinutes: Math.round(summary.totalTimeMinutes * 100) / 100,
            totalCost: Math.round(summary.totalCost * 100) / 100,
          },
        };
      } catch (err) {
        if (err instanceof SessionNotFoundError) throw httpError('Oturum bulunamadi', 404);
        throw err;
      }
    },

    /** GET /session/:id/report — Final session report */
    async getReport(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      assertSessionOwnership(request, id);

      const session = sessionManager.getSession(id);
      if (!session) throw httpError('Oturum bulunamadi', 404);

      const budget = sessionManager.checkBudget(id);

      const report: SessionReportResponse = {
        sessionId: id,
        owner: session.owner,
        repo: session.repo,
        status: session.status === 'expired' ? 'completed' : (session.status as 'completed' | 'cancelled'),
        tasks: session.selectedTasks.map((t) => {
          const completed = session.completedTasks.find((c) => c.taskId === t.taskId);
          return {
            id: t.taskId,
            title: t.title,
            category: t.category,
            description: t.description ?? '',
            status: t.status,
            criticScore: completed?.criticScore ?? null,
            timeSpentSeconds: completed
              ? Math.floor((completed.completedAt.getTime() - completed.startedAt.getTime()) / 1000)
              : 0,
          };
        }),
        totalTimeSeconds: Math.floor(session.elapsedMinutes * 60),
        totalCost: Math.round(budget.actualCost * 100) / 100,
        prUrl: session.prUrl ?? null,
        completedAt: new Date().toISOString(),
      };

      return { report };
    },
  };
}
