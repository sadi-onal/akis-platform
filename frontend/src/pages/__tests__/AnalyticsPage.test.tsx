import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

// ---- mocks ----

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Mock recharts to avoid SVG rendering in jsdom
vi.mock('recharts', () => {
  const createMockComponent = (name: string) => {
    const Mock = ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) =>
      React.createElement('div', { 'data-testid': `mock-${name}`, ...props }, children);
    Mock.displayName = name;
    return Mock;
  };
  return {
    AreaChart: createMockComponent('AreaChart'),
    Area: createMockComponent('Area'),
    BarChart: createMockComponent('BarChart'),
    Bar: createMockComponent('Bar'),
    XAxis: createMockComponent('XAxis'),
    YAxis: createMockComponent('YAxis'),
    CartesianGrid: createMockComponent('CartesianGrid'),
    Tooltip: createMockComponent('Tooltip'),
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'mock-ResponsiveContainer' }, children),
    PieChart: createMockComponent('PieChart'),
    Pie: createMockComponent('Pie'),
    Cell: createMockComponent('Cell'),
    Legend: createMockComponent('Legend'),
  };
});

const MOCK_DATA = {
  period: '30d',
  summary: {
    totalPipelines: 42,
    totalTokens: 1500000,
    inputTokens: 1000000,
    outputTokens: 500000,
    cacheReadTokens: 200000,
    cacheCreationTokens: 50000,
    cacheSavingsPercent: 12,
    successRate: 85,
    avgDurationMs: 45000,
    estimatedCostUsd: 1.234,
  },
  timeSeries: [
    { date: '2026-05-01', pipelines: 5, tokens: 100000, inputTokens: 60000, outputTokens: 40000, cost: 0.1, successCount: 4, failCount: 1 },
  ],
  providerBreakdown: [
    { provider: 'anthropic', calls: 100, tokens: 1200000, cost: 1.0, avgDurationMs: 3000 },
  ],
  modelBreakdown: [
    { model: 'claude-sonnet-4-6', provider: 'anthropic', calls: 80, inputTokens: 800000, outputTokens: 400000, cost: 0.8 },
  ],
  agentBreakdown: [
    { agent: 'scribe', calls: 30, inputTokens: 400000, outputTokens: 200000, avgConfidence: 0.92 },
  ],
  purposeBreakdown: [
    { purpose: 'spec_generation', calls: 30, tokens: 500000, cost: 0.4 },
  ],
  pipelinePerformance: {
    avgScribeDurationMs: 15000,
    avgProtoDurationMs: 20000,
    avgTraceDurationMs: 10000,
    avgTotalDurationMs: 45000,
    topErrors: [{ code: 'AI_RATE_LIMITED', count: 3 }],
    retrysByStage: { proto_building: 2 },
  },
  criticStats: {
    totalReviews: 20,
    approvalRate: 75,
    avgScore: 7.5,
    fixLoopTriggerRate: 10,
    iterateLoopCount: 4,
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigateMock.mockReset();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(MOCK_DATA),
  });
  vi.stubGlobal('fetch', fetchMock);
});

async function renderPage() {
  const mod = await import('../AnalyticsPage');
  const AnalyticsPage = mod.default;
  render(
    <BrowserRouter>
      <AnalyticsPage />
    </BrowserRouter>,
  );
}

describe('AnalyticsPage', () => {
  it('renders KPI cards with correct values after loading', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('42')).toBeTruthy();
    });
    expect(screen.getByText('1.5M')).toBeTruthy();
    expect(screen.getByText('85%')).toBeTruthy();
    expect(screen.getByText('45.0s')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('renders the page title', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.title')).toBeTruthy();
    });
  });

  it('renders period selector buttons', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.period.7d')).toBeTruthy();
    });
    expect(screen.getByText('analytics.period.14d')).toBeTruthy();
    expect(screen.getByText('analytics.period.30d')).toBeTruthy();
    expect(screen.getByText('analytics.period.90d')).toBeTruthy();
  });

  it('changes period when button clicked', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.period.7d')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('analytics.period.7d'));
    // Verify fetch was called again with new period
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const lastUrl = calls[calls.length - 1]?.[0] as string;
      expect(lastUrl).toContain('period=7d');
    });
  });

  it('renders error state and retry button', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    });
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.error')).toBeTruthy();
    });
    expect(screen.getByText('analytics.error.retry')).toBeTruthy();
  });

  it('renders empty state when no pipelines', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ...MOCK_DATA,
        summary: { ...MOCK_DATA.summary, totalPipelines: 0 },
      }),
    });
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.empty')).toBeTruthy();
    });
  });

  it('renders provider breakdown table', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('anthropic')).toBeTruthy();
    });
  });

  it('renders agent breakdown table', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('scribe')).toBeTruthy();
    });
  });

  it('renders critic stats', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('analytics.critic.title')).toBeTruthy();
    });
    expect(screen.getByText('75%')).toBeTruthy();
  });
});
