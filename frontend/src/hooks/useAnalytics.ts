import { useState, useEffect, useCallback } from 'react';

export type Period = '7d' | '14d' | '30d' | '90d';

export interface AnalyticsSummary {
  totalPipelines: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheSavingsPercent: number;
  successRate: number;
  avgDurationMs: number;
  estimatedCostUsd: number;
}

export interface TimeSeriesPoint {
  date: string;
  pipelines: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  successCount: number;
  failCount: number;
}

export interface ProviderBreakdownItem {
  provider: string;
  calls: number;
  tokens: number;
  cost: number;
  avgDurationMs: number;
}

export interface ModelBreakdownItem {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AgentBreakdownItem {
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  avgConfidence: number | null;
}

export interface PurposeBreakdownItem {
  purpose: string;
  calls: number;
  tokens: number;
  cost: number;
}

export interface PipelinePerformance {
  avgScribeDurationMs: number;
  avgProtoDurationMs: number;
  avgTraceDurationMs: number;
  avgTotalDurationMs: number;
  topErrors: Array<{ code: string; count: number }>;
  retrysByStage: Record<string, number>;
}

export interface CriticStats {
  totalReviews: number;
  approvalRate: number;
  avgScore: number;
  fixLoopTriggerRate: number;
  iterateLoopCount: number;
}

export interface AnalyticsData {
  period: string;
  summary: AnalyticsSummary;
  timeSeries: TimeSeriesPoint[];
  providerBreakdown: ProviderBreakdownItem[];
  modelBreakdown: ModelBreakdownItem[];
  agentBreakdown: AgentBreakdownItem[];
  purposeBreakdown: PurposeBreakdownItem[];
  pipelinePerformance: PipelinePerformance;
  criticStats: CriticStats;
}

interface UseAnalyticsResult {
  data: AnalyticsData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAnalytics(period: Period): UseAnalyticsResult {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics?period=${period}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: AnalyticsData = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  return { data, isLoading, error, refetch: fetchAnalytics };
}
