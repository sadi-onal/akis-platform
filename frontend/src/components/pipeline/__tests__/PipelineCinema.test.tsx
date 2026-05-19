import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub useReducedMotion so animations are deterministic in tests
vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

// ConfidenceBadge requires I18nProvider; stub here so the tree renders.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { PipelineCinema } from '../PipelineCinema';
import { reduceStageViews } from '../PipelineCinema.utils';
import type { PipelineActivity } from '../../../hooks/usePipelineStream';

const mk = (overrides: Partial<PipelineActivity>): PipelineActivity => ({
  pipelineId: 'p',
  stage: 'scribe',
  step: 'progress',
  message: '',
  timestamp: new Date().toISOString(),
  ...overrides,
});

// PR-F (2026-05-19): Cinema 5 column → 3 column refactor.
//   [0] scribe, [1] proto, [2] trace
// Critic ana column değil; critic_spec aktiviteleri Scribe column'una,
// critic_code aktiviteleri Proto column'una map'lenir.
describe('reduceStageViews (pure, 3-column PR-F)', () => {
  it('marks all stages pending when no activities', () => {
    const views = reduceStageViews([], null);
    expect(views.map((v) => v.state)).toEqual(['pending', 'pending', 'pending']);
  });

  it('marks stages left of current as complete and current as active', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 40 }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current);
    expect(views[0]!.state).toBe('complete'); // scribe
    expect(views[1]!.state).toBe('active'); // proto
    expect(views[2]!.state).toBe('pending'); // trace
    expect(views[1]!.progress).toBe(40);
  });

  it('marks current as complete when progress hits 100', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'trace', progress: 100 })];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[2]!.state).toBe('complete');
  });

  it('folds fix-loop activity into Proto column', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 100 }),
      mk({ stage: 'trace', progress: 60, message: 'trace fail' }),
      mk({ stage: 'fix-loop', progress: 30, message: 'fix retry' }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current);
    // fix-loop maps to proto column
    expect(views[1]!.latest?.message).toBe('fix retry');
    expect(views[1]!.state).toBe('active');
  });

  it('captures reasoning per stage when present', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'scribe',
        progress: 100,
        reasoning: { decision: 'Spec hazır', confidence: 88 },
      }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[0]!.reasoning?.decision).toBe('Spec hazır');
    expect(views[0]!.reasoning?.confidence).toBe(88);
  });

  it('ignores unknown stage values', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'unknown' as PipelineActivity['stage'], progress: 50 }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[0]!.state).toBe('complete');
  });

  it('uses uiState to drive activeIdx instead of latest activity stage', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 30 }),
    ];
    // Latest activity is proto, uiState says proto_running → proto is active
    const views = reduceStageViews(acts, acts[1]!, 'proto_running');
    expect(views[0]!.state).toBe('complete'); // scribe
    expect(views[1]!.state).toBe('active'); // proto
    expect(views[2]!.state).toBe('pending'); // trace
  });

  // PR-F: Critic activities map to Scribe/Proto columns silently.
  // PR-F1 (2026-05-19): Display text (`latest.message`) artık native stage'den
  // geliyor — Critic activity progress/reasoning'i devralabilir ama Scribe
  // kartının yazısı "Spec yazılıyor" (Scribe) olarak kalır, Critic'in mesajı
  // değil. Manuel test bulgusu (image #41).
  it('routes critic criticPhase=spec into Scribe column but keeps native display message', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 60, message: 'Spec yazılıyor' }),
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        message: 'Spec inceleme bitti',
        reasoning: { decision: 'Spec onaylandi', confidence: 80 },
      }),
    ];
    const views = reduceStageViews(acts, acts[1]!);
    // PR-F1: latest.message is the Scribe native activity, NOT the Critic event.
    expect(views[0]!.latest?.message).toBe('Spec yazılıyor');
    expect(views[0]!.latest?.stage).toBe('scribe');
    // Reasoning + progress still take the Critic event into account so the
    // overall column status (complete/active) reflects guardrail outcome.
    expect(views[0]!.reasoning?.decision).toBe('Spec onaylandi');
    expect(views[0]!.progress).toBe(100);
    // Proto/Trace stay untouched.
    expect(views[1]!.latest).toBeNull();
    expect(views[2]!.latest).toBeNull();
  });

  it('routes critic criticPhase=code into Proto column without overwriting display', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 100, message: 'Kod hazır' }),
      mk({
        stage: 'critic',
        criticPhase: 'code',
        progress: 100,
        message: 'Kod inceleme bitti',
        reasoning: { decision: 'Kod onaylandi', confidence: 75 },
      }),
    ];
    const views = reduceStageViews(acts, acts[2]!);
    // PR-F1: Proto kartı kendi mesajını gösterir, Critic'in mesajı değil.
    expect(views[1]!.latest?.message).toBe('Kod hazır');
    expect(views[1]!.latest?.stage).toBe('proto');
    expect(views[1]!.reasoning?.confidence).toBe(75);
  });

  it('keeps native display message when criticPhase is missing (DB-replay)', () => {
    // Replay scenario: backend restart, pipeline_activities replay without
    // criticPhase field. Cinema routes by position for progress/state, but
    // display text remains the native (non-critic) activity.
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, message: 'spec done' }),
      mk({ stage: 'critic', progress: 100, message: 'spec review' }),
      mk({ stage: 'proto', progress: 100, message: 'proto done' }),
      mk({ stage: 'critic', progress: 100, message: 'code review' }),
    ];
    const views = reduceStageViews(acts, acts[3]!);
    // Native scribe activity → display.
    expect(views[0]!.latest?.message).toBe('spec done');
    // Native proto activity → display.
    expect(views[1]!.latest?.message).toBe('proto done');
  });

  // PR-F1: Specifically guard against the manuel test 2026-05-19 regression —
  // Scribe column never renders Critic's "(adversarial review)" message.
  it('PR-F1: Scribe column NEVER displays critic message even when critic is last', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, message: 'Spec inceleme için hazır' }),
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        message: 'Spesifikasyon inceleniyor (adversarial review)...',
      }),
    ];
    const views = reduceStageViews(acts, acts[1]!);
    expect(views[0]!.latest?.message).toBe('Spec inceleme için hazır');
    expect(views[0]!.latest?.message).not.toContain('adversarial');
  });

  // PR-F: Trace iterate-loop retry badge meta exposure
  it('extracts retryCount + maxRetries from Trace retry-trigger activity', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'trace', progress: 50 }),
      mk({
        stage: 'trace',
        step: 'retry-trigger',
        retryCount: 2,
        progress: 80,
        message: 'Test eksik kaldı (2/3 kabul kriteri) — Proto yeniden çalışıyor (2/3)',
      }),
    ];
    const views = reduceStageViews(acts, acts[1]!);
    expect(views[2]!.meta?.retryCount).toBe(2);
    expect(views[2]!.meta?.maxRetries).toBe(3);
  });

  it('does NOT set retry meta when no retry-trigger activity emitted', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'trace', progress: 100 })];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[2]!.meta?.retryCount).toBeUndefined();
  });
});

describe('PipelineCinema component (PR-F 3-column)', () => {
  it('renders three columns (Scribe / Proto / Trace) — no Critic columns', () => {
    render(<PipelineCinema activities={[]} currentStep={null} />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Proto')).toBeInTheDocument();
    expect(screen.getByText('Trace')).toBeInTheDocument();
    // Critic column labels must NOT appear anywhere — they were folded into
    // Scribe/Proto cards as part of the PR-F refactor.
    expect(screen.queryByText('Critic · Spec')).not.toBeInTheDocument();
    expect(screen.queryByText('Critic · Kod')).not.toBeInTheDocument();
  });

  it('attaches bakkal-Türkçesi tooltip to each stage card', () => {
    const { container } = render(<PipelineCinema activities={[]} currentStep={null} />);
    const stages: Array<{ name: string; expected: string }> = [
      { name: 'scribe', expected: "Fikri spec'e çevirir" },
      { name: 'proto', expected: "Spec'ten kod üretir" },
      { name: 'trace', expected: 'Otomatik test üretir' },
    ];
    for (const { name, expected } of stages) {
      const card = container.querySelector(`[data-stage="${name}"]`);
      expect(card, `card for ${name} should exist`).toBeTruthy();
      expect(card?.getAttribute('title')).toContain(expected);
    }
  });

  it('renders compact toggle when callback provided', () => {
    const onToggle = vi.fn();
    render(<PipelineCinema activities={[]} currentStep={null} onToggleCompact={onToggle} />);
    const btn = screen.getByRole('button', { name: /Kompakt görünüm/ });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('switches button label when in compact mode', () => {
    const onToggle = vi.fn();
    render(
      <PipelineCinema activities={[]} currentStep={null} compact onToggleCompact={onToggle} />,
    );
    expect(screen.getByRole('button', { name: /Geniş görünüm/ })).toBeInTheDocument();
  });

  it('renders approval slot when provided', () => {
    render(
      <PipelineCinema
        activities={[]}
        currentStep={null}
        approvalSlot={<button>Onayla</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Onayla' })).toBeInTheDocument();
  });

  it('shows confidence badge on stage with reasoning', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'scribe',
        progress: 100,
        reasoning: { decision: 'Approved', confidence: 88 },
      }),
    ];
    render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    expect(screen.getByLabelText(/88%/)).toBeInTheDocument();
  });

  it('renders Trace retry badge when iterate-loop activity present', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'trace',
        step: 'retry-trigger',
        retryCount: 2,
        progress: 80,
        message: 'Test eksik kaldı — Proto yeniden çalışıyor (2/3)',
      }),
    ];
    render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    expect(screen.getByTestId('trace-retry-badge')).toHaveTextContent(/2\/3/);
  });

  it('does NOT render Trace retry badge in steady-state', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'trace', progress: 100 })];
    const { queryByTestId } = render(
      <PipelineCinema activities={acts} currentStep={acts[0]!} />,
    );
    expect(queryByTestId('trace-retry-badge')).toBeNull();
  });

  it('exposes data-cinema-mode attribute', () => {
    const { container, rerender } = render(<PipelineCinema activities={[]} currentStep={null} />);
    expect(container.querySelector('[data-cinema-mode="full"]')).toBeTruthy();
    rerender(<PipelineCinema activities={[]} currentStep={null} compact />);
    expect(container.querySelector('[data-cinema-mode="compact"]')).toBeTruthy();
  });

  it('marks active stage with data-state=active', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'proto', progress: 50, message: 'Yazıyor' })];
    const { container } = render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    const proto = container.querySelector('[data-stage="proto"]');
    expect(proto).toHaveAttribute('data-state', 'active');
  });
});
