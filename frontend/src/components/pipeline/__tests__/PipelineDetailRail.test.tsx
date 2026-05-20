import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

// ConfidenceBadge (transitively rendered) requires I18nProvider; stub here.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { PipelineDetailRail } from '../PipelineDetailRail';
import type { PipelineActivity } from '../../../hooks/usePipelineStream';
import type { PipelineExplanation, RegressionReport } from '../../../types/pipeline';

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

  // F-04 — completed pipelines whose in-memory activity buffer was lost
  // (e.g. after a backend restart) must still surface the rail so the
  // user can reach Akış / Açıklama / Regresyon for finished work.
  describe('F-04 — pipelineHasOutputs override', () => {
    it('returns null when idle + zero activities + pipelineHasOutputs=false (default)', () => {
      const { container } = render(
        <PipelineDetailRail
          pipelineId="p-1"
          uiState="idle"
          activities={[]}
          currentStep={null}
          pipelineHasOutputs={false}
        />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders the rail (collapsed) when idle + zero activities + pipelineHasOutputs=true', () => {
      render(
        <PipelineDetailRail
          pipelineId="p-1"
          uiState="idle"
          activities={[]}
          currentStep={null}
          pipelineHasOutputs
        />
      );
      const region = screen.getByLabelText('Pipeline detayı');
      expect(region).toBeInTheDocument();
      // Idle + completed → auto-collapsed by default
      expect(region).toHaveAttribute('data-collapsed', 'true');
    });

    it('keeps tabs accessible when expanded with outputs but no activities', () => {
      const fetcher = vi.fn().mockResolvedValue(mkExpl());
      render(
        <PipelineDetailRail
          pipelineId="p-1"
          uiState="idle"
          activities={[]}
          currentStep={null}
          pipelineHasOutputs
          explanationFetcher={fetcher}
        />
      );
      // Expand the rail
      fireEvent.click(screen.getByText(/Pipeline detayı/));
      const region = screen.getByLabelText('Pipeline detayı');
      expect(region).toHaveAttribute('data-collapsed', 'false');
      // Akış + Açıklama tabs always available
      expect(screen.getByRole('tab', { name: 'Akış' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Açıklama' })).toBeInTheDocument();
      // F-04: Regresyon is also reachable on persisted outputs alone —
      // RegressionPanel fetches its report straight from the workflow
      // record, so it works fine even with an empty activity buffer.
      expect(screen.getByRole('tab', { name: 'Regresyon' })).toBeInTheDocument();
    });
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

describe('PipelineDetailRail — P5b/T1 AI Logs tab', () => {
  // T1 removed the production debug gate — the tab is now visible to every
  // user by default. Tests can still pass `showAiLogsTab={false}` to render
  // the rail without it (so other tab assertions stay deterministic).
  it('hides the AI Logları tab when showAiLogsTab is false', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        showAiLogsTab={false}
      />
    );
    expect(screen.queryByRole('tab', { name: 'pipeline.aiLogs.tab' })).toBeNull();
  });

  it('shows the AI Logları tab when showAiLogsTab is true', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        showAiLogsTab
      />
    );
    expect(screen.getByRole('tab', { name: 'pipeline.aiLogs.tab' })).toBeInTheDocument();
  });

  it('clicking the AI Logları tab triggers the aiCallsFetcher', async () => {
    const aiCallsFetcher = vi.fn().mockResolvedValue([]);
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        showAiLogsTab
        aiCallsFetcher={aiCallsFetcher}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'pipeline.aiLogs.tab' }));
    await waitFor(() => expect(aiCallsFetcher).toHaveBeenCalledWith('p-1'));
    // Empty state renders without crashing.
    await waitFor(() => expect(screen.getByTestId('ai-calls-empty')).toBeInTheDocument());
  });

  it('shows the AI Logları tab by default (T1 — no debug gate)', () => {
    // T1: the debug gate (URL/localStorage/env) is gone. With no
    // `showAiLogsTab` prop the tab is visible.
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.getByRole('tab', { name: 'pipeline.aiLogs.tab' })).toBeInTheDocument();
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
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
        explanationFetcher={fetcher}
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
    const explFetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
        regressionFetcher={fetcher}
        explanationFetcher={explFetcher}
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
    const explFetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('proto')]}
        currentStep={null}
        regressionFetcher={fetcher}
        explanationFetcher={explFetcher}
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

// PR-B (user feedback 2026-05-15 #5): AttentionBanner +
// CriticResolutionGate must only surface on the Akış (flow) tab. Before
// this fix they rendered above both tabs so the Açıklama tab looked
// "buried under banners". Header badge stays unchanged (count is useful
// metadata at every tab).
describe('PipelineDetailRail — PR-B tab scoping', () => {
  it('renders AttentionBanner inside the body on the Akış tab', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mkExpl({
        attentionPoints: [{ severity: 'high', stage: 'critic', issue: 'XSS-test-issue' }],
      })
    );
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
      />
    );
    // Flow tab is auto-active on proto_running; switch to why so the
    // explanationFetcher fires and we can verify attentionPoints made
    // it into state. Then switch back to flow.
    fireEvent.click(screen.getByRole('tab', { name: 'Açıklama' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
    await screen.findByText(/1 dikkat noktası/);
    fireEvent.click(screen.getByRole('tab', { name: 'Akış' }));
    expect(await screen.findByText('XSS-test-issue')).toBeInTheDocument();
  });

  it('does NOT render AttentionBanner body content on the Açıklama tab', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mkExpl({
        attentionPoints: [{ severity: 'high', stage: 'critic', issue: 'XSS-test-issue' }],
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
    // awaiting_approval auto-routes to Açıklama (why) tab.
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'why');
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
    // Header badge still shows the count …
    expect(await screen.findByText(/1 dikkat noktası/)).toBeInTheDocument();
    // … but the inline banner body content is no longer rendered on this tab.
    expect(screen.queryByText('XSS-test-issue')).toBeNull();
  });

  it('renders a vertical resize handle below the body when expanded', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    const handle = screen.getByTestId('pipeline-rail-resize-handle');
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    expect(handle).toHaveAttribute('aria-controls', 'pipeline-rail-body');
  });

  it('does NOT render the resize handle when the rail is collapsed', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('scribe')]}
        currentStep={null}
      />
    );
    // idle + activities → rail is mounted but auto-collapsed.
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryByTestId('pipeline-rail-resize-handle')).toBeNull();
  });
});

// ─── PR-V2 — Critic findings dedup chip (Akış-tab summary) ─────────────
//
// V2 moved the full Critic-findings UI to the Açıklama tab and replaced it
// on the Akış tab with a single summary chip ("N Critic bulgusu — Açıklama'da").
// The chip is only meant to surface when there ARE findings AND no critic
// gate is currently active (otherwise CriticResolutionGate already shows
// the full panel — duplicate noise).
describe('PipelineDetailRail — PR-V2 Critic findings summary chip', () => {
  const baseFinding = {
    severity: 'major' as const,
    category: 'completeness',
    description: 'AC-1 belirsiz',
    suggestion: 'GWT formatına çevirin',
  };

  it('does NOT render the chip when criticReview is undefined', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.queryByTestId('critic-findings-summary-chip')).toBeNull();
  });

  it('does NOT render the chip when criticReview.findings is an empty array', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        criticReview={{
          approved: true,
          overallScore: 95,
          findings: [],
          summary: 'Spec sağlam.',
          reviewType: 'spec_review',
          iteration: 1,
        }}
      />
    );
    expect(screen.queryByTestId('critic-findings-summary-chip')).toBeNull();
  });

  it('renders the chip with the exact finding count when findings.length is 1', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        criticReview={{
          approved: false,
          overallScore: 70,
          findings: [baseFinding],
          summary: '1 finding',
          reviewType: 'spec_review',
          iteration: 1,
        }}
      />
    );
    const chip = screen.getByTestId('critic-findings-summary-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('1 Critic bulgusu');
  });

  it('renders the chip with a large count (10+) without truncating the number', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...baseFinding,
      description: `Issue ${i + 1}`,
    }));
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        criticReview={{
          approved: false,
          overallScore: 40,
          findings: many,
          summary: 'many findings',
          reviewType: 'spec_review',
          iteration: 1,
        }}
      />
    );
    const chip = screen.getByTestId('critic-findings-summary-chip');
    expect(chip).toHaveTextContent('12 Critic bulgusu');
  });

  it('does NOT render the chip when criticGateActive (awaiting_critic_resolution) — avoids duplicate with CriticResolutionGate', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_critic_resolution"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        criticReview={{
          approved: false,
          overallScore: 50,
          findings: [baseFinding, baseFinding],
          summary: 'critical block',
          reviewType: 'code_review',
          iteration: 1,
        }}
      />
    );
    // The full CriticResolutionGate already covers this case at the top
    // of the Akış tab; rendering the chip below would be redundant noise.
    expect(screen.queryByTestId('critic-findings-summary-chip')).toBeNull();
  });

  it('clicking the chip switches the active tab to Açıklama (why)', () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
        criticReview={{
          approved: false,
          overallScore: 65,
          findings: [baseFinding],
          summary: 'one finding',
          reviewType: 'spec_review',
          iteration: 1,
        }}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'flow');
    fireEvent.click(screen.getByTestId('critic-findings-summary-chip'));
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'why');
  });

  it('chip is scoped to the Akış tab — switching to Açıklama unmounts it', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
        criticReview={{
          approved: false,
          overallScore: 65,
          findings: [baseFinding],
          summary: 'one finding',
          reviewType: 'spec_review',
          iteration: 1,
        }}
      />
    );
    expect(screen.getByTestId('critic-findings-summary-chip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Açıklama' }));
    // Once the user is on the Açıklama tab the full findings panel renders
    // there — the summary chip is no longer needed and is unmounted.
    expect(screen.queryByTestId('critic-findings-summary-chip')).toBeNull();
  });

  it('does NOT render the chip when criticReview.findings is undefined (legacy / partial output)', () => {
    // Older pipelines or partial payloads might omit the findings array
    // entirely. `(criticReview.findings?.length ?? 0) > 0` must coerce
    // missing → 0 → no chip.
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        criticReview={
          {
            approved: true,
            overallScore: 80,
            summary: 'no findings field',
            reviewType: 'spec_review',
            iteration: 1,
          } as unknown as import('../../../types/pipeline').CriticReviewOutput
        }
      />
    );
    expect(screen.queryByTestId('critic-findings-summary-chip')).toBeNull();
  });
});

describe('PipelineDetailRail — T2 Jira Epic link', () => {
  it('renders a clickable Atlassian link when epicKey + siteUrl are set', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        jiraConfig={{
          projectKey: 'AKIS',
          enabled: true,
          epicKey: 'AKIS-42',
          siteUrl: 'https://example.atlassian.net',
        }}
      />
    );
    const link = screen.getByRole('link', { name: /AKIS-42/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://example.atlassian.net/browse/AKIS-42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders epic name as plain badge (no link) when siteUrl is missing', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        jiraConfig={{
          projectKey: 'AKIS',
          enabled: true,
          epicKey: 'AKIS-42',
        }}
      />
    );
    expect(screen.queryByRole('link', { name: /AKIS-42/i })).toBeNull();
    expect(screen.getByText(/Jira Epic: AKIS-42/)).toBeInTheDocument();
  });

  it('renders nothing when epicKey is missing (Jira disabled or Epic creation failed)', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        jiraConfig={{
          projectKey: 'AKIS',
          enabled: true,
        }}
      />
    );
    expect(screen.queryByText(/Jira Epic/)).toBeNull();
  });

  it('renders nothing when jiraConfig is undefined (Jira disabled at start)', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.queryByText(/Jira Epic/)).toBeNull();
  });
});

describe('PipelineDetailRail — T3 CI pill', () => {
  it('renders an amber "CI çalışıyor…" badge when uiState=ci_running and no result yet', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="ci_running"
        activities={[mkActivity('trace')]}
        currentStep={mkActivity('trace')}
      />
    );
    expect(screen.getByTestId('ci-pill-running')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-pill-success')).toBeNull();
    expect(screen.queryByTestId('ci-pill-failed')).toBeNull();
  });

  it('renders a green ✓ pill linked to GitHub Actions when ciResult.ok is true', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('trace')]}
        currentStep={null}
        ciResult={{
          ok: true,
          runId: 42,
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/o/r/actions/runs/42',
        }}
      />
    );
    const pill = screen.getByTestId('ci-pill-success');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute('href', 'https://github.com/o/r/actions/runs/42');
    expect(pill).toHaveAttribute('target', '_blank');
    expect(pill).toHaveTextContent(/Başarılı/i);
  });

  it('renders a red ✗ pill when ciResult.ok is false', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('trace')]}
        currentStep={null}
        ciResult={{
          ok: false,
          runId: 43,
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/o/r/actions/runs/43',
        }}
      />
    );
    const pill = screen.getByTestId('ci-pill-failed');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/Başarısız/i);
  });

  it('renders nothing CI-related when ciResult is undefined and uiState is not ci_running', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('trace')]}
        currentStep={null}
      />
    );
    expect(screen.queryByTestId('ci-pill-running')).toBeNull();
    expect(screen.queryByTestId('ci-pill-success')).toBeNull();
    expect(screen.queryByTestId('ci-pill-failed')).toBeNull();
  });
});
