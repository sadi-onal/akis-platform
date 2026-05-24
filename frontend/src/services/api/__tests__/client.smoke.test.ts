import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../client';

describe('API Client Smoke Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle getRoot with mock fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'akis-platform',
        status: 'ok',
        version: '0.2.0',
      }),
      headers: new Headers({ 'request-id': 'test-request-id' }),
    });

    const result = await api.getRoot();

    expect(result.name).toBe('akis-platform');
    expect(result.status).toBe('ok');
  });

  it('should handle getHealth with mock fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        timestamp: '2024-01-01T00:00:00Z',
      }),
      headers: new Headers({ 'request-id': 'health-request-id' }),
    });

    const result = await api.getHealth();

    expect(result.status).toBe('ok');
  });

  it('should handle getDashboardMetrics with mock fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        period: '7d',
        avgQualityScore: 85,
        successRate: 0.95,
        totalJobs: 100,
        completedJobs: 95,
        failedJobs: 5,
        topFailureReason: null,
        topFailureCount: 0,
      }),
      headers: new Headers({ 'request-id': 'metrics-request-id' }),
    });

    const result = await api.getDashboardMetrics('7d');

    expect(result.period).toBe('7d');
    expect(result.successRate).toBe(0.95);
  });
});
