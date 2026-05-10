import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PipelineDetailRail } from '../PipelineDetailRail';
import type { PipelineActivity } from '../../../hooks/usePipelineStream';
import type { PipelineExplanation, RegressionReport } from '../../../types/pipeline';

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

const mkExpl = (overrides: Partial<PipelineExplanation> = {}): PipelineExplanation => ({
  pipelineId: 'p-1',
  stages: [
    {
      agentName: 'scribe',
      timestamp: new Date().toISOString(),
      decision: 'Spec uretildi',
      reasoning: ['1 soru'],
      assumptions: [],
      confidence: { score: 90, factors: [] },
    },
  ],
  overallNarrative: 'Tamamlandı.',
  attentionPoints: [],
  ...overrides,
});

const mkActivity = (stage: PipelineActivity['stage'], progress = 50): PipelineActivity => ({
  pipelineId: 'p-1',
  stage,
  step: 'progress',
  message: 'çalışıyor',
  progress,
  timestamp: new Date().toISOString(),
});

describe('PipelineDetailRail — render gating', () => {
  it('renders nothing when no pipelineId', () => {
    const { container } = render(
      <PipelineDetailRail
        pipelineId={undefined}
        uiState="idle"
        activities={[]}
        currentStep={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when pipelineId is 'pending'", () => {
    const { container } = render(
      <PipelineDetailRail pipelineId="pending" uiState="idle" activities={[]} currentStep={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when idle and no activities', () => {
    const { container } = render(
      <PipelineDetailRail pipelineId="p-1" uiState="idle" activities={[]} currentStep={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when there are activities even in idle state', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('scribe')]}
        currentStep={mkActivity('scribe')}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toBeInTheDocument();
  });
});

describe('PipelineDetailRail — auto state', () => {
  it('auto-collapses when idle/completed', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('scribe')]}
        currentStep={null}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'true');
  });

  it('auto-expands while running with Akış tab active', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'false');
    expect(region).toHaveAttribute('data-active-tab', 'flow');
  });

  it('auto-expands at awaiting_approval with Açıklama tab active', () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'false');
    expect(region).toHaveAttribute('data-active-tab', 'why');
  });
});

describe('PipelineDetailRail — interactions', () => {
  it('user can manually collapse an auto-expanded rail', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-collapsed', 'false');
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-collapsed', 'true');
  });

  it('user can manually switch tabs', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'flow');
    fireEvent.click(screen.getByRole('tab', { name: 'Açıklama' }));
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'why');
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
  });

  it('shows attention point count badge in header when present', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mkExpl({
        attentionPoints: [
          { severity: 'high', stage: 'critic', issue: 'XSS' },
          { severity: 'medium', stage: 'scribe', issue: 'belirsiz' },
        ],
      })
    );
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    expect(await screen.findByText(/2 dikkat noktası/)).toBeInTheDocument();
  });

  it('does not fetch explanation while in flow tab', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
      />
    );
    // settle one microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders fetcher error when explanation request fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network down'));
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});

const mkRegression = (overrides: Partial<RegressionReport> = {}): RegressionReport => ({
  pipelineId: 'p-1',
  baseline: {
    totalTests: 4,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
  fixLoop: { runs: 0, succeeded: false, triggered: false },
  status: 'verified_baseline',
  headline: 'Doğrulanmış baseline: 4 test, %100 kapsam',
  bakkalSummary: 'Projenin baseline güveni: 4 testle %100 kapsam.',
  ...overrides,
});

describe('PipelineDetailRail — body scrollability (F-02)', () => {
  // F-02: when ExplanationPanel renders many stage cards or AttentionBanner
  // accumulates findings, the rail used to expand past the viewport with
  // no scroll affordance. Body must cap height + allow vertical scroll.
  it('body wrapper has overflow-y-auto and exact max-h tokens on the Akış tab', () => {
    const { container } = render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-active-tab', 'flow');
    const body = container.querySelector('#pipeline-rail-body');
    expect(body).not.toBeNull();
    const classes = body!.className;
    expect(classes).toContain('overflow-y-auto');
    // Lock the exact breakpoint tokens so silent drift (e.g. md:max-h-screen) fails the test.
    expect(classes).toContain('max-h-[55vh]');
    expect(classes).toContain('sm:max-h-[60vh]');
    // Prevent scroll-chain into the parent chat container.
    expect(classes).toContain('overscroll-contain');
    // Keyboard-only users must be able to focus the scroll viewport (WCAG 2.1.1).
    expect(body).toHaveAttribute('tabindex', '0');
  });

  it('body wrapper retains overflow + exact max-h tokens on the Açıklama tab with many attention points', async () => {
    const longAttention = Array.from({ length: 12 }, (_, i) => ({
      severity: (i % 3 === 0 ? 'high' : 'medium') as 'high' | 'medium',
      stage: 'critic' as const,
      issue: `Issue ${i + 1} — uzun bir açıklama metni içeren dikkat noktası örneği.`,
    }));
    const fetcher = vi.fn().mockResolvedValue(
      mkExpl({
        attentionPoints: longAttention,
      })
    );
    const { container } = render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    // Wait for the badge so we know the explanation fetched and AttentionBanner mounted inside the body.
    expect(await screen.findByText(/12 dikkat noktası/)).toBeInTheDocument();
    const body = container.querySelector('#pipeline-rail-body');
    expect(body).not.toBeNull();
    const classes = body!.className;
    expect(classes).toContain('overflow-y-auto');
    expect(classes).toContain('max-h-[55vh]');
    expect(classes).toContain('sm:max-h-[60vh]');
  });

  it('body wrapper remains scrollable on the Regresyon tab', () => {
    const { container } = render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
      />
    );
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    fireEvent.click(screen.getByRole('tab', { name: 'Regresyon' }));
    const body = container.querySelector('#pipeline-rail-body');
    expect(body).not.toBeNull();
    const classes = body!.className;
    expect(classes).toContain('overflow-y-auto');
    expect(classes).toContain('max-h-[55vh]');
    expect(classes).toContain('sm:max-h-[60vh]');
  });
});

describe('PipelineDetailRail — Regresyon tab', () => {
  it('shows the Regresyon tab when the user opens an idle rail with activities', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
      />
    );
    // Auto-collapsed at idle — opening the rail reveals tabs.
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    expect(screen.getByRole('tab', { name: 'Regresyon' })).toBeInTheDocument();
  });

  it('does not show the Regresyon tab while a stage is still running', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.queryByRole('tab', { name: 'Regresyon' })).not.toBeInTheDocument();
  });

  it('calls regressionFetcher once after the user opens the rail and clicks Regresyon', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkRegression());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
        regressionFetcher={fetcher}
      />
    );
    // Auto-collapsed at idle — open it.
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    fireEvent.click(screen.getByRole('tab', { name: 'Regresyon' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders RegressionPanel content when the Regresyon tab is active', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkRegression());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
        regressionFetcher={fetcher}
      />
    );
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    fireEvent.click(screen.getByRole('tab', { name: 'Regresyon' }));
    expect(
      await screen.findByText(/Doğrulanmış baseline: 4 test, %100 kapsam/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Regresyon güven yüzeyi')).toBeInTheDocument();
  });
});
