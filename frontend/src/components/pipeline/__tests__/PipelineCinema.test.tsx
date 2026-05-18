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

// PR-A Fix 4: views are now 5-wide:
//   [0] scribe, [1] critic_spec, [2] proto, [3] critic_code, [4] trace
describe('reduceStageViews (pure)', () => {
  it('marks all stages pending when no activities', () => {
    const views = reduceStageViews([], null);
    expect(views.map((v) => v.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('marks stages left of current as complete and current as active', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'spec', progress: 100 }),
      mk({ stage: 'proto', progress: 40 }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current);
    expect(views[0]!.state).toBe('complete'); // scribe
    expect(views[1]!.state).toBe('complete'); // critic_spec
    expect(views[2]!.state).toBe('active'); // proto
    expect(views[3]!.state).toBe('pending'); // critic_code
    expect(views[4]!.state).toBe('pending'); // trace
    expect(views[2]!.progress).toBe(40);
  });

  it('marks current as complete when progress hits 100', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'trace', progress: 100 })];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[4]!.state).toBe('complete');
  });

  it('folds fix-loop activity into Proto column', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'spec', progress: 100 }),
      mk({ stage: 'proto', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'code', progress: 100 }),
      mk({ stage: 'trace', progress: 60, message: 'trace fail' }),
      mk({ stage: 'fix-loop', progress: 30, message: 'fix retry' }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current);
    // fix-loop maps to proto column
    expect(views[2]!.latest?.message).toBe('fix retry');
    expect(views[2]!.state).toBe('active');
  });

  it('captures reasoning per critic phase when present', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        reasoning: { decision: 'Spec onaylandi', confidence: 88 },
      }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[1]!.reasoning?.decision).toBe('Spec onaylandi');
    expect(views[1]!.reasoning?.confidence).toBe(88);
  });

  it('keeps last reasoning when later events overwrite', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 50,
        reasoning: { decision: 'Inceleniyor', confidence: 0 },
      }),
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        reasoning: { decision: 'Spec onaylandi', confidence: 92 },
      }),
    ];
    const views = reduceStageViews(acts, acts[1]!);
    expect(views[1]!.reasoning?.decision).toBe('Spec onaylandi');
    expect(views[1]!.reasoning?.confidence).toBe(92);
  });

  it('ignores unknown stage values', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'unknown' as PipelineActivity['stage'], progress: 50 }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    // unknown stage doesn't crash and doesn't pollute any column
    expect(views[0]!.state).toBe('complete');
  });

  it('Bulgu D: settles Critic·Spec to complete at awaiting_approval even when current is a stale critic activity', () => {
    // Reproduces the bug: SSE buffer keeps the last critic activity as
    // `current` while the pipeline is parked at awaiting_approval. Without
    // a uiState hint the column would stay pulsing forever.
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 80,
        message: 'Spesifikasyon inceleniyor…',
      }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current, 'awaiting_approval');
    expect(views[1]!.state).toBe('complete');
  });

  it('uses uiState to drive activeIdx instead of latest activity stage', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'spec', progress: 100 }),
      mk({ stage: 'proto', progress: 30 }),
    ];
    // Latest activity is proto, uiState says proto_running → proto is active
    const views = reduceStageViews(acts, acts[2]!, 'proto_running');
    expect(views[0]!.state).toBe('complete'); // scribe
    expect(views[1]!.state).toBe('complete'); // critic_spec
    expect(views[2]!.state).toBe('active'); // proto
    expect(views[3]!.state).toBe('pending'); // critic_code
    expect(views[4]!.state).toBe('pending'); // trace
  });

  it('settles every touched stage to complete at awaiting_push_confirm', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'spec', progress: 100 }),
      mk({ stage: 'proto', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'code', progress: 100 }),
    ];
    const views = reduceStageViews(acts, acts[3]!, 'awaiting_push_confirm');
    expect(views[0]!.state).toBe('complete');
    expect(views[1]!.state).toBe('complete');
    expect(views[2]!.state).toBe('complete');
    expect(views[3]!.state).toBe('complete');
    expect(views[4]!.state).toBe('pending');
  });

  // PR-A Fix 4: new — explicit critic split coverage
  it('routes critic activity with criticPhase=spec into critic_spec column', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        message: 'Spec inceleme bitti',
        reasoning: { decision: 'Spec onaylandi', confidence: 80 },
      }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[1]!.stage).toBe('critic_spec');
    expect(views[1]!.latest?.message).toBe('Spec inceleme bitti');
    expect(views[3]!.stage).toBe('critic_code');
    expect(views[3]!.latest).toBeNull();
  });

  it('routes critic activity with criticPhase=code into critic_code column', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', criticPhase: 'spec', progress: 100 }),
      mk({ stage: 'proto', progress: 100 }),
      mk({
        stage: 'critic',
        criticPhase: 'code',
        progress: 100,
        message: 'Kod inceleme bitti',
        reasoning: { decision: 'Kod onaylandi', confidence: 75 },
      }),
    ];
    const views = reduceStageViews(acts, acts[3]!);
    expect(views[3]!.stage).toBe('critic_code');
    expect(views[3]!.latest?.message).toBe('Kod inceleme bitti');
    expect(views[3]!.reasoning?.confidence).toBe(75);
  });

  it('falls back to chronology when criticPhase is missing (DB-reconstructed activity)', () => {
    // Replay scenario: a backend restart left the cinema rebuilding from
    // pipeline_activities rows, which (today) don't persist criticPhase.
    // Cinema should still place the first critic batch before proto and
    // the second after.
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'critic', progress: 100, message: 'spec review' }),
      mk({ stage: 'proto', progress: 100 }),
      mk({ stage: 'critic', progress: 100, message: 'code review' }),
    ];
    const views = reduceStageViews(acts, acts[3]!);
    expect(views[1]!.latest?.message).toBe('spec review');
    expect(views[3]!.latest?.message).toBe('code review');
  });
});

describe('PipelineCinema component', () => {
  it('renders all five stages including split critic columns', () => {
    render(<PipelineCinema activities={[]} currentStep={null} />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    // PR-A Fix 4: critic split into spec + kod
    expect(screen.getByText('Critic · Spec')).toBeInTheDocument();
    expect(screen.getByText('Proto')).toBeInTheDocument();
    expect(screen.getByText('Critic · Kod')).toBeInTheDocument();
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });

  it('attaches bakkal-Türkçesi tooltip to each stage card (PR-A Fix 3)', () => {
    const { container } = render(<PipelineCinema activities={[]} currentStep={null} />);
    const stages: Array<{ name: string; expected: string }> = [
      { name: 'scribe', expected: "Fikri spec'e çevirir" },
      { name: 'critic_spec', expected: "Spec'i denetler" },
      { name: 'proto', expected: "Spec'ten kod üretir" },
      { name: 'critic_code', expected: 'kalite incelemesi' },
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
      <PipelineCinema activities={[]} currentStep={null} compact onToggleCompact={onToggle} />
    );
    expect(screen.getByRole('button', { name: /Geniş görünüm/ })).toBeInTheDocument();
  });

  it('renders approval slot when provided', () => {
    render(
      <PipelineCinema activities={[]} currentStep={null} approvalSlot={<button>Onayla</button>} />
    );
    expect(screen.getByRole('button', { name: 'Onayla' })).toBeInTheDocument();
  });

  it('shows confidence badge for stage with reasoning', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        progress: 100,
        reasoning: { decision: 'Approved', confidence: 88 },
      }),
    ];
    render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    // ConfidenceBadge renders as a button with the score
    const badge = screen.getAllByRole('button').find((b) => b.textContent?.includes('88%'));
    expect(badge).toBeDefined();
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
