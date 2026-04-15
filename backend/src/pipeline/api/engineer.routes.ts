/**
 * Engineer Rental Mode routes — stub implementations.
 *
 * Routes:
 *   POST   /api/engineer/discover         → Discover tasks in a repo
 *   POST   /api/engineer/session          → Create engineer session
 *   POST   /api/engineer/session/:id/start   → Start session timer
 *   GET    /api/engineer/session/:id         → Get session status
 *   GET    /api/engineer/session/:id/progress → Get current progress
 *   POST   /api/engineer/session/:id/pause    → Pause session
 *   POST   /api/engineer/session/:id/resume   → Resume session
 *   POST   /api/engineer/session/:id/cancel   → Cancel session
 *   GET    /api/engineer/session/:id/report   → Final session report
 */

import { randomUUID } from 'node:crypto';

// ─── Request/Response Types ──────────────────────────────

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

export interface DiscoveredTask {
  id: string;
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'docs' | 'security' | 'test' | 'refactor';
  estimatedMinutes: number;
  complexity: 1 | 2 | 3;
  affectedFiles: string[];
}

export type SessionStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled';

export interface EngineerSession {
  id: string;
  owner: string;
  repo: string;
  status: SessionStatus;
  tasks: SessionTask[];
  timeBudgetMinutes: number;
  timeRemainingSeconds: number;
  startedAt: string | null;
  createdAt: string;
}

export interface SessionTask {
  id: string;
  title: string;
  category: DiscoveredTask['category'];
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  criticScore: number | null;
  timeSpentSeconds: number;
}

export interface SessionProgress {
  sessionId: string;
  status: SessionStatus;
  currentTask: SessionTask | null;
  completedTasks: SessionTask[];
  queuedTasks: SessionTask[];
  timeRemainingSeconds: number;
  elapsedSeconds: number;
}

export interface SessionReport {
  sessionId: string;
  owner: string;
  repo: string;
  status: 'completed' | 'cancelled';
  tasks: Array<SessionTask & { description: string }>;
  totalTimeSeconds: number;
  totalCost: number;
  prUrl: string | null;
  completedAt: string;
}

// ─── Route Deps ──────────────────────────────────────────

export interface EngineerRouteDeps {
  getUserId: (request: unknown) => string;
  // TODO: Wire TaskDiscoveryService when available
  // TODO: Wire SessionManager when available
}

// ─── Mock Data ───────────────────────────────────────────

const MOCK_TASKS: DiscoveredTask[] = [
  {
    id: 'task-001',
    title: 'Hata: Login formu bos email kabul ediyor',
    description: 'Login formunda email alani bos birakildiginda form submit ediliyor. Frontend validasyonu eksik.',
    category: 'bug',
    estimatedMinutes: 15,
    complexity: 1,
    affectedFiles: ['src/pages/auth/LoginEmail.tsx', 'src/utils/validation.ts'],
  },
  {
    id: 'task-002',
    title: 'Ozellik: Dark mode toggle eklenmesi',
    description: 'Kullanici ayarlarindan dark/light mode secenegi. Tailwind class-based dark mode kullanilacak.',
    category: 'feature',
    estimatedMinutes: 45,
    complexity: 2,
    affectedFiles: ['src/App.tsx', 'src/components/AppShell.tsx', 'src/contexts/ThemeContext.tsx'],
  },
  {
    id: 'task-003',
    title: 'Dokumantasyon: API endpoint\'leri icin JSDoc eklenmesi',
    description: 'Backend route handler\'lari icin eksik JSDoc yorumlari eklenmeli.',
    category: 'docs',
    estimatedMinutes: 20,
    complexity: 1,
    affectedFiles: ['src/api/auth.ts', 'src/api/github.ts', 'src/api/settings/index.ts'],
  },
  {
    id: 'task-004',
    title: 'Guvenlik: Rate limiting eksik endpoint\'ler',
    description: 'Bazi API endpoint\'lerinde rate limiting uygulanmamis. Brute-force saldiri riski.',
    category: 'security',
    estimatedMinutes: 30,
    complexity: 2,
    affectedFiles: ['src/api/auth.ts', 'src/middleware/rateLimiter.ts'],
  },
  {
    id: 'task-005',
    title: 'Test: Settings sayfasi icin unit testler',
    description: 'SettingsPage component\'i icin birim testleri yazilmali. Mevcut coverage %0.',
    category: 'test',
    estimatedMinutes: 35,
    complexity: 2,
    affectedFiles: ['src/pages/settings/SettingsPage.test.tsx'],
  },
  {
    id: 'task-006',
    title: 'Refactor: HttpClient retry mantigi basitlestirme',
    description: 'HttpClient\'taki retry mantigi karmisik — ayri bir RetryPolicy sinifina cikarilmali.',
    category: 'refactor',
    estimatedMinutes: 25,
    complexity: 3,
    affectedFiles: ['src/services/api/HttpClient.ts', 'src/services/api/RetryPolicy.ts'],
  },
  {
    id: 'task-007',
    title: 'Hata: Mobil gorunumde sidebar tasma',
    description: 'Kucuk ekranlarda sidebar icerigi container disina tasiyor. Responsive duzeltme gerekli.',
    category: 'bug',
    estimatedMinutes: 20,
    complexity: 1,
    affectedFiles: ['src/components/Sidebar.tsx', 'src/styles/sidebar.css'],
  },
];

// In-memory session store (stub — will be replaced by DB)
const sessions = new Map<string, EngineerSession>();

// ─── Route Creators ──────────────────────────────────────

export function createEngineerRoutes(deps: EngineerRouteDeps) {
  const { getUserId } = deps;

  return {
    /** POST /discover — Analyze repo and discover tasks */
    async discover(request: unknown) {
      getUserId(request); // auth check
      const body = (request as { body: DiscoverBody }).body;

      if (!body.owner || !body.repo) {
        throw Object.assign(new Error('owner ve repo alanlari zorunludur'), { statusCode: 400 });
      }

      // TODO: Replace with real TaskDiscoveryService.discover(owner, repo, hint)
      // For now return mock tasks, optionally filtered by hint
      let tasks = [...MOCK_TASKS];
      if (body.hint) {
        const hint = body.hint.toLowerCase();
        tasks = tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(hint) ||
            t.description.toLowerCase().includes(hint) ||
            t.category === hint,
        );
      }

      return {
        owner: body.owner,
        repo: body.repo,
        tasks,
        analyzedAt: new Date().toISOString(),
      };
    },

    /** POST /session — Create a new engineer session */
    async createSession(request: unknown) {
      getUserId(request);
      const body = (request as { body: CreateSessionBody }).body;

      if (!body.owner || !body.repo) {
        throw Object.assign(new Error('owner ve repo alanlari zorunludur'), { statusCode: 400 });
      }
      if (!body.selectedTaskIds?.length) {
        throw Object.assign(new Error('En az bir gorev secilmelidir'), { statusCode: 400 });
      }
      if (body.selectedTaskIds.length > 5) {
        throw Object.assign(new Error('En fazla 5 gorev secilebilir'), { statusCode: 400 });
      }
      if (!body.timeBudgetMinutes || body.timeBudgetMinutes < 1) {
        throw Object.assign(new Error('Zaman butcesi en az 1 dakika olmalidir'), { statusCode: 400 });
      }

      // TODO: Replace with real SessionManager.create(...)
      const sessionId = randomUUID();
      const selectedTasks: SessionTask[] = body.selectedTaskIds.map((taskId) => {
        const mock = MOCK_TASKS.find((t) => t.id === taskId);
        return {
          id: taskId,
          title: mock?.title ?? `Gorev ${taskId}`,
          category: mock?.category ?? 'feature',
          status: 'queued' as const,
          criticScore: null,
          timeSpentSeconds: 0,
        };
      });

      const session: EngineerSession = {
        id: sessionId,
        owner: body.owner,
        repo: body.repo,
        status: 'created',
        tasks: selectedTasks,
        timeBudgetMinutes: body.timeBudgetMinutes,
        timeRemainingSeconds: body.timeBudgetMinutes * 60,
        startedAt: null,
        createdAt: new Date().toISOString(),
      };

      sessions.set(sessionId, session);
      return { session };
    },

    /** POST /session/:id/start — Start session timer */
    async startSession(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }
      if (session.status !== 'created' && session.status !== 'paused') {
        throw Object.assign(new Error('Oturum baslatilabilir durumda degil'), { statusCode: 400 });
      }

      // TODO: Replace with real SessionManager.start(id) — starts timer + agent work
      session.status = 'running';
      session.startedAt = session.startedAt ?? new Date().toISOString();

      // Mark the first queued task as in_progress
      const nextTask = session.tasks.find((t) => t.status === 'queued');
      if (nextTask) {
        nextTask.status = 'in_progress';
      }

      return { session };
    },

    /** GET /session/:id — Get session status */
    async getSession(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }

      return { session };
    },

    /** GET /session/:id/progress — Current task + time remaining */
    async getProgress(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }

      // TODO: Replace with real SessionManager.getProgress(id) — computes from running timer
      const currentTask = session.tasks.find((t) => t.status === 'in_progress') ?? null;
      const completedTasks = session.tasks.filter((t) => t.status === 'completed');
      const queuedTasks = session.tasks.filter((t) => t.status === 'queued');

      // Simulate time passage for demo
      const elapsedSeconds = session.startedAt
        ? Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000)
        : 0;
      const timeRemainingSeconds = Math.max(0, session.timeBudgetMinutes * 60 - elapsedSeconds);

      const progress: SessionProgress = {
        sessionId: id,
        status: session.status,
        currentTask,
        completedTasks,
        queuedTasks,
        timeRemainingSeconds,
        elapsedSeconds,
      };

      return { progress };
    },

    /** POST /session/:id/pause — Pause session */
    async pauseSession(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }
      if (session.status !== 'running') {
        throw Object.assign(new Error('Sadece calisan oturumlar duraklatilabilir'), { statusCode: 400 });
      }

      // TODO: Replace with real SessionManager.pause(id)
      session.status = 'paused';
      return { session };
    },

    /** POST /session/:id/resume — Resume session */
    async resumeSession(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }
      if (session.status !== 'paused') {
        throw Object.assign(new Error('Sadece duraklatilmis oturumlar devam ettirilebilir'), { statusCode: 400 });
      }

      // TODO: Replace with real SessionManager.resume(id)
      session.status = 'running';
      return { session };
    },

    /** POST /session/:id/cancel — Cancel session */
    async cancelSession(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }
      if (session.status === 'completed' || session.status === 'cancelled') {
        throw Object.assign(new Error('Tamamlanmis veya iptal edilmis oturumlar tekrar iptal edilemez'), { statusCode: 400 });
      }

      // TODO: Replace with real SessionManager.cancel(id)
      session.status = 'cancelled';
      return { session };
    },

    /** GET /session/:id/report — Final session report */
    async getReport(request: unknown) {
      getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const session = sessions.get(id);

      if (!session) {
        throw Object.assign(new Error('Oturum bulunamadi'), { statusCode: 404 });
      }

      // TODO: Replace with real SessionManager.getReport(id) — generates from DB records
      // For now, simulate a completed report with mock critic scores
      const tasks = session.tasks.map((t) => {
        const mock = MOCK_TASKS.find((m) => m.id === t.id);
        return {
          ...t,
          description: mock?.description ?? '',
          status: session.status === 'completed' ? ('completed' as const) : t.status,
          criticScore: session.status === 'completed' ? Math.floor(70 + Math.random() * 30) : t.criticScore,
          timeSpentSeconds: session.status === 'completed'
            ? (mock?.estimatedMinutes ?? 10) * 60
            : t.timeSpentSeconds,
        };
      });

      const totalTimeSeconds = tasks.reduce((sum, t) => sum + t.timeSpentSeconds, 0);
      const costPerMinute = session.timeBudgetMinutes <= 30
        ? 0.50 / 30
        : session.timeBudgetMinutes <= 60
          ? 1.00 / 60
          : session.timeBudgetMinutes <= 120
            ? 2.00 / 120
            : 3.00 / 180;

      const report: SessionReport = {
        sessionId: id,
        owner: session.owner,
        repo: session.repo,
        status: session.status === 'cancelled' ? 'cancelled' : 'completed',
        tasks,
        totalTimeSeconds,
        totalCost: Math.round(session.timeBudgetMinutes * costPerMinute * 100) / 100,
        prUrl: session.status === 'completed'
          ? `https://github.com/${session.owner}/${session.repo}/pull/42`
          : null,
        completedAt: new Date().toISOString(),
      };

      return { report };
    },
  };
}
