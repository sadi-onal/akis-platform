/**
 * Engineer Rental Mode API client.
 */
import { HttpClient } from './HttpClient';
import { getApiBaseUrl } from './config';

const http = new HttpClient(getApiBaseUrl());

// ─── Types ───────────────────────────────────────────────

export type TaskCategory = 'bug' | 'feature' | 'docs' | 'security' | 'test' | 'refactor';

export interface DiscoveredTask {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  estimatedMinutes: number;
  complexity: 1 | 2 | 3;
  affectedFiles: string[];
}

export interface DiscoverResponse {
  owner: string;
  repo: string;
  tasks: DiscoveredTask[];
  analyzedAt: string;
}

export type SessionStatus = 'created' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface SessionTask {
  id: string;
  title: string;
  category: TaskCategory;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  criticScore: number | null;
  timeSpentSeconds: number;
}

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

export interface CreateSessionParams {
  owner: string;
  repo: string;
  selectedTaskIds: string[];
  timeBudgetMinutes: number;
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

// ─── API Methods ─────────────────────────────────────────

export const engineerApi = {
  discoverTasks: (owner: string, repo: string, hint?: string): Promise<DiscoverResponse> =>
    http.post('/api/engineer/discover', { owner, repo, hint }),

  createSession: (params: CreateSessionParams): Promise<{ session: EngineerSession }> =>
    http.post('/api/engineer/session', params),

  startSession: (sessionId: string): Promise<{ session: EngineerSession }> =>
    http.post(`/api/engineer/session/${sessionId}/start`),

  getSession: (sessionId: string): Promise<{ session: EngineerSession }> =>
    http.get(`/api/engineer/session/${sessionId}`),

  getSessionProgress: (sessionId: string): Promise<{ progress: SessionProgress }> =>
    http.get(`/api/engineer/session/${sessionId}/progress`),

  pauseSession: (sessionId: string): Promise<{ session: EngineerSession }> =>
    http.post(`/api/engineer/session/${sessionId}/pause`),

  resumeSession: (sessionId: string): Promise<{ session: EngineerSession }> =>
    http.post(`/api/engineer/session/${sessionId}/resume`),

  cancelSession: (sessionId: string): Promise<{ session: EngineerSession }> =>
    http.post(`/api/engineer/session/${sessionId}/cancel`),

  getSessionReport: (sessionId: string): Promise<{ report: SessionReport }> =>
    http.get(`/api/engineer/session/${sessionId}/report`),
};
