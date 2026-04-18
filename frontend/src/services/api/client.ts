import { HttpClient } from './HttpClient';
import type { Job, JobsListResponse, CreateJobRequest, CreateJobResponse, DashboardMetrics } from './types';

const httpClient = new HttpClient();

export const api = {
  // GET /api/agents/jobs
  getJobs: async (params?: {
    type?: 'scribe' | 'trace' | 'proto';
    state?: 'pending' | 'running' | 'completed' | 'failed';
    limit?: number;
    cursor?: string;
  }): Promise<JobsListResponse> => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set('type', params.type);
    if (params?.state) searchParams.set('state', params.state);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.cursor) searchParams.set('cursor', params.cursor);

    const query = searchParams.toString();
    return httpClient.get<JobsListResponse>(`/api/agents/jobs${query ? `?${query}` : ''}`);
  },

  // GET /api/agents/jobs/:id
  getJob: async (id: string, include?: string[]): Promise<Job & { requestId?: string }> => {
    const searchParams = new URLSearchParams();
    if (include && include.length > 0) {
      searchParams.set('include', include.join(','));
    }

    const query = searchParams.toString();
    return httpClient.get<Job & { requestId?: string }>(
      `/api/agents/jobs/${id}${query ? `?${query}` : ''}`
    );
  },

  // POST /api/agents/jobs
  createJob: async (
    request: CreateJobRequest
  ): Promise<CreateJobResponse & { requestId?: string }> => {
    return httpClient.post<CreateJobResponse & { requestId?: string }>('/api/agents/jobs', request);
  },

  // POST /api/agents/jobs/:id/approve - S1.2: Approve a job
  approveJob: async (
    id: string,
    comment?: string
  ): Promise<{ success: boolean; message: string; approvedBy: string; approvedAt: string }> => {
    return httpClient.post(`/api/agents/jobs/${id}/approve`, { comment });
  },

  // POST /api/agents/jobs/:id/reject - S1.2: Reject a job
  rejectJob: async (
    id: string,
    comment?: string
  ): Promise<{ success: boolean; message: string; rejectedBy: string; rejectedAt: string }> => {
    return httpClient.post(`/api/agents/jobs/${id}/reject`, { comment });
  },

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
  submitFeedback: async (data: { rating: number; message: string; page?: string }): Promise<{ id: string; createdAt: string }> => {
    return httpClient.post('/api/feedback', data);
  },

  // GET /api/usage/current-month
  getUsage: async (): Promise<{
    period: { start: string; end: string };
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; jobCount: number };
    freeQuota: { tokens: number; costUsd: number };
    used: { tokens: number; costUsd: number };
    remaining: { tokens: number; costUsd: number };
    onDemand: { tokens: number; costUsd: number };
    percentUsed: { tokens: number; cost: number };
    daily?: Array<{ date: string; tokens: number; cost: number; jobs: number }>;
  }> => {
    return httpClient.get('/api/usage/current-month');
  },

  // GET /api/billing/plan — current user plan + usage
  getBillingPlan: async (): Promise<{
    plan: {
      planId: string;
      tier: string;
      name: string;
      jobsPerDay: number;
      maxTokenBudget: number;
      maxAgents: number;
      depthModesAllowed: string[];
      maxOutputTokensPerJob: number;
      passesAllowed: number;
      priorityQueue: boolean;
      priceMonthly: number;
    };
    usage: {
      jobsToday: number;
      tokensThisMonth: number;
      jobsLimit: number;
      tokenLimit: number;
    };
    unlimited: boolean;
    role: string;
  }> => {
    return httpClient.get('/api/billing/plan');
  },

  // GET /api/usage — consolidated usage with plan data
  getUsageWithPlan: async (): Promise<{
    totalJobs: number;
    totalTokens: number;
    estimatedCost: number;
    period: string;
    plan: {
      planId: string;
      tier: string;
      name: string;
      jobsPerDay: number;
      maxTokenBudget: number;
      maxAgents: number;
      depthModesAllowed: string[];
      maxOutputTokensPerJob: number;
      passesAllowed: number;
      priorityQueue: boolean;
      priceMonthly: number;
    };
    /** Admin role or billing override → the UI should render ∞ instead of numeric limits. */
    unlimited: boolean;
    role: string;
    /**
     * Remaining quota. Null for unlimited users (Infinity isn't JSON-serializable);
     * the UI renders ∞ when null.
     */
    remaining: { jobs: number | null; tokens: number | null };
    usage: {
      jobsUsedToday: number;
      tokensUsedThisMonth: number;
      jobsLimit: number;
      tokensLimit: number;
      percentJobsUsed: number;
      percentTokensUsed: number;
    };
  }> => {
    return httpClient.get('/api/usage');
  },

  // GET /api/billing/plans — all available plans
  getAvailablePlans: async (): Promise<{
    plans: Array<{
      id: string;
      tier: string;
      name: string;
      description: string | null;
      jobsPerDay: number;
      maxTokenBudget: number;
      maxAgents: number;
      depthModesAllowed: string[];
      maxOutputTokensPerJob: number;
      passesAllowed: number;
      priorityQueue: boolean;
      priceMonthly: number;
      priceYearly: number | null;
      isActive: boolean;
    }>;
  }> => {
    return httpClient.get('/api/billing/plans');
  },

  // GET /api/billing/notifications
  getBillingNotifications: async (): Promise<{
    notifications: Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      readAt: string | null;
      createdAt: string;
    }>;
  }> => {
    return httpClient.get('/api/billing/notifications');
  },
};
