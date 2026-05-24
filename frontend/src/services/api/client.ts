import { HttpClient } from './HttpClient';
import type { DashboardMetrics } from './types';

const httpClient = new HttpClient();

export const api = {
  // GET /
  getRoot: async (): Promise<{ name: string; status: string; version: string }> => {
    return httpClient.get('/');
  },

  // GET /health
  getHealth: async (): Promise<{ status: string; timestamp?: string }> => {
    return httpClient.get('/health');
  },

  // GET /ready
  getReady: async (): Promise<{ ready: boolean }> => {
    return httpClient.get('/ready');
  },

  // GET /version
  getVersion: async (): Promise<{ version: string }> => {
    return httpClient.get('/version');
  },

  // GET /api/dashboard/metrics
  getDashboardMetrics: async (period: '7d' | '30d' = '7d'): Promise<DashboardMetrics> => {
    return httpClient.get<DashboardMetrics>(`/api/dashboard/metrics?period=${period}`);
  },

  // POST /api/feedback
  submitFeedback: async (data: {
    rating: number;
    message: string;
    page?: string;
  }): Promise<{ id: string; createdAt: string }> => {
    return httpClient.post('/api/feedback', data);
  },

  // GET /api/usage/current-month — monthly token/cost analytics (no quota gating)
  getUsage: async (): Promise<{
    period: { start: string; end: string };
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
      jobCount: number;
    };
    daily?: Array<{ date: string; tokens: number; cost: number; jobs: number }>;
    /** True when the caller is an admin. Admins also receive `breakdown` + `wholesaleCostUsd`. */
    userIsAdmin?: boolean;
    wholesaleCostUsd?: number;
    breakdown?: {
      wholesale: number;
      retail: number;
      input: number;
      output: number;
      margin: number;
      markup: number;
    };
  }> => {
    return httpClient.get('/api/usage/current-month');
  },
};
