import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub useReducedMotion so animations are deterministic in tests
vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

// ConfidenceBadge requires I18nProvider; stub here so the tree renders.
// PR-T2: cinema header + toggle now read from i18n; mirror the TR strings so
// the existing regex assertions keep matching real user-facing copy.
const CINEMA_MESSAGES: Record<string, string> = {
  'pipeline.cinema.title': 'Pipeline akışı',
  'pipeline.cinema.toggleCompact': 'Kompakt görünüm',
  'pipeline.cinema.toggleWide': 'Geniş görünüm',
};
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => CINEMA_MESSAGES[key] ?? key,
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

  // PR-V5: completion is now driven by explicit `status: 'completed'`
  // activities. The old "left-of-current ⇒ complete" heuristic produced
  // premature checkmarks — see PR-V5 in CHANGELOG.
  it('marks stages with explicit completed status as complete and current as active', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 40 }),
    ];
    const current = acts[acts.length - 1]!;
    const views = reduceStageViews(acts, current);
    expect(views[0]!.state).toBe('complete'); // scribe (explicit completed)
    expect(views[1]!.state).toBe('active'); // proto (latest activity, no completion yet)
    expect(views[2]!.state).toBe('pending'); // trace
    expect(views[1]!.progress).toBe(40);
  });

  it('marks current as complete only when an explicit completion activity arrives', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'trace', progress: 100, status: 'completed', step: 'stage_completed' }),
    ];
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
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'unknown' as PipelineActivity['stage'], progress: 50 }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[0]!.state).toBe('complete');
  });

  it('uses uiState to drive activeIdx — explicit completion drives the previous columns', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 30 }),
    ];
    // Latest activity is proto, uiState says proto_running → proto is active
    const views = reduceStageViews(acts, acts[1]!, 'proto_running');
    expect(views[0]!.state).toBe('complete'); // scribe (explicit completion)
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

  // PR-F3 (2026-05-19): Critic critical-finding iterate-loop retry meta on
  // Proto column. Critic `criticPhase=code` + `step=retry-trigger` activity
  // is interpreted as "Critic is re-driving Proto" — badge appears on the
  // Proto card with retrySource='critic' so the UI can label it
  // "Critic düzeltiyor (n/m)" instead of "Test deniyor (n/m)".
  it('PR-F3: extracts Critic retry meta from criticPhase=code retry-trigger into Proto column', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 100, message: 'Kod hazır' }),
      mk({
        stage: 'critic',
        criticPhase: 'code',
        step: 'retry-trigger',
        retryCount: 2,
        progress: 80,
        message: 'Değerlendirme kritik bulgu raporladı — Proto yeniden çalışıyor (2/3)',
      }),
    ];
    const views = reduceStageViews(acts, acts[2]!);
    expect(views[1]!.meta?.retryCount).toBe(2);
    expect(views[1]!.meta?.maxRetries).toBe(3);
    expect(views[1]!.meta?.retrySource).toBe('critic');
    // Trace column untouched.
    expect(views[2]!.meta?.retryCount).toBeUndefined();
  });

  it('PR-F3: Trace iterate retry meta still tagged with retrySource=trace', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'trace',
        step: 'retry-trigger',
        retryCount: 1,
        progress: 80,
        message: 'Test eksik kaldı (2/3 kabul kriteri) — Proto yeniden çalışıyor (1/3)',
      }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[2]!.meta?.retrySource).toBe('trace');
    expect(views[2]!.meta?.retryCount).toBe(1);
    expect(views[2]!.meta?.maxRetries).toBe(3);
  });

  // PR-V (2026-05-20) Bug 2 — UI stale state on Trace fallback.
  // When Trace dry-run hits the 3-retry cap and the orchestrator opens the
  // push gate without tests, the cinema used to keep showing the stale
  // "Test deniyor (3)" badge plus the "Playwright testleri oluşturuluyor
  // (deneme 3)..." shimmer forever. The fix: backend emits an explicit
  // `step: 'stage_completed'` (status: 'completed') for the trace stage
  // BEFORE the gate_open event, and the cinema utility resets retry meta
  // when that signal arrives.
  it('PR-V: stage_completed activity clears Trace retry meta after dry-run failure', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'trace',
        step: 'retry-trigger',
        retryCount: 3,
        progress: 80,
        message: 'Yeniden deneniyor (3/3)',
      }),
      mk({
        stage: 'trace',
        step: 'stage_completed',
        status: 'completed',
        progress: 100,
        message: 'Test üretilemedi (devam ediliyor)',
      }),
      mk({
        stage: 'trace',
        step: 'gate_open',
        progress: 100,
        message: 'Gönderim onayı bekleniyor',
      }),
    ];
    const views = reduceStageViews(acts, acts[acts.length - 1]!, 'awaiting_push_confirm');
    // Trace column: meta cleared (no stale retry badge), state = complete
    // (explicit signal), latest message = the neutral gate_open text.
    expect(views[2]!.meta?.retryCount).toBeUndefined();
    expect(views[2]!.meta?.maxRetries).toBeUndefined();
    expect(views[2]!.state).toBe('complete');
    expect(views[2]!.latest?.message).toBe('Gönderim onayı bekleniyor');
  });

  it('PR-V: without stage_completed, Trace retry meta persists (regression guard)', () => {
    // Sanity check: removing the stage_completed signal restores the old
    // broken behavior. Pins the contract — the reset is gated on the
    // explicit completion step, not on any other field.
    const acts: PipelineActivity[] = [
      mk({
        stage: 'trace',
        step: 'retry-trigger',
        retryCount: 3,
        progress: 80,
        message: 'Yeniden deneniyor (3/3)',
      }),
      mk({
        stage: 'trace',
        step: 'gate_open',
        progress: 100,
        message: 'Gönderim onayı bekleniyor',
      }),
    ];
    const views = reduceStageViews(acts, acts[1]!, 'awaiting_push_confirm');
    expect(views[2]!.meta?.retryCount).toBe(3);
  });

  // ─── PR-V5: explicit-completion completion logic ────────────────────
  // Pre-PR-V5 the frontend inferred completion from "stage is no longer
  // the latest activity" — which fired premature checkmarks at every
  // Scribe→Proto / Proto→Trace handoff. PR-V5 derives completion ONLY
  // from explicit `status: 'completed'` activities. The two cases below
  // pin down the new contract.
  it('PR-V5: completion ONLY derived from explicit completed-status activities', () => {
    // Both Scribe and Proto have in-progress activities. Without an
    // explicit completion signal, Scribe must NOT be marked complete just
    // because Proto activities have arrived (the old bug).
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 60, message: 'Spec yazılıyor' }),
      mk({ stage: 'proto', progress: 10, message: 'Proto başladı' }),
    ];
    const views = reduceStageViews(acts, acts[1]!, 'proto_running');
    expect(views[0]!.state).not.toBe('complete'); // scribe: no explicit completion
    expect(views[1]!.state).toBe('active'); // proto: live
    expect(views[2]!.state).toBe('pending'); // trace: untouched
  });

  it('PR-V5: explicit completed activity marks the stage as complete', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 30, message: 'Kod yazılıyor' }),
    ];
    const views = reduceStageViews(acts, acts[1]!, 'proto_running');
    expect(views[0]!.state).toBe('complete'); // scribe: explicit completion
    expect(views[1]!.state).toBe('active'); // proto: live
    expect(views[2]!.state).toBe('pending'); // trace: untouched
  });

  it('PR-F3: critic retry-trigger WITHOUT criticPhase=code is NOT routed as Critic iterate', () => {
    // Defensive: only `criticPhase: 'code'` activities should drive the
    // Proto-column Critic badge. Spec-phase retry-triggers (currently not
    // emitted, but reserved) should not surface as Critic iterate.
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        step: 'retry-trigger',
        retryCount: 1,
        progress: 60,
        message: 'spec retry (1/3)',
      }),
    ];
    const views = reduceStageViews(acts, acts[0]!);
    expect(views[1]!.meta?.retryCount).toBeUndefined();
    expect(views[1]!.meta?.retrySource).toBeUndefined();
  });

  // ─── PR-V5 edge-case regression tests (test sweep, 2026-05-19) ─────────

  it('PR-V5: duplicate stage_completed activities are idempotent (Set dedup)', () => {
    // The orchestrator emits one completion per stage, but a buffer replay
    // or double-flush could deliver two. The reducer must not double-count
    // — it stores stages in a Set keyed by stage name.
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 30 }),
    ];
    const views = reduceStageViews(acts, acts[2]!, 'proto_running');
    expect(views[0]!.state).toBe('complete');
    expect(views[1]!.state).toBe('active');
    expect(views[2]!.state).toBe('pending');
  });

  it('PR-V5: a "failed" status activity does NOT mark the stage complete', () => {
    // Only `status === 'completed'` should drive the completion Set. A
    // failure status (existing backend convention) must be ignored by the
    // dedup logic — otherwise a failed Trace would show a check.
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'trace', progress: 80, status: 'failed' }),
    ];
    // uiState idle here would push everything to complete via the legacy
    // back-compat branch. Use a running uiState so Trace's failure stays
    // visible — pending, not complete.
    const views = reduceStageViews(acts, acts[2]!, 'trace_running');
    expect(views[0]!.state).toBe('complete');
    expect(views[1]!.state).toBe('complete');
    // Trace: explicit completion absent + uiState says it's live → active.
    expect(views[2]!.state).toBe('active');
  });

  it('PR-V5: stage_completed for trace marks trace complete even when uiState is still trace_running (race)', () => {
    // Race: SSE delivers stage_completed before the orchestrator persists
    // the uiState transition. The explicit completion signal must win over
    // the in-flight uiState — otherwise the user sees "running" while the
    // stage really finished.
    const acts: PipelineActivity[] = [
      mk({ stage: 'trace', progress: 100, status: 'completed', step: 'stage_completed' }),
    ];
    const views = reduceStageViews(acts, acts[0]!, 'trace_running');
    // Explicit completion wins.
    expect(views[2]!.state).toBe('complete');
  });

  it('PR-V5: out-of-order stage_completed (trace before proto) — both still register', () => {
    // SSE in network-jittered environments can deliver later activities
    // first. The Set-based collection must not depend on order.
    const acts: PipelineActivity[] = [
      mk({ stage: 'trace', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'proto', progress: 100, status: 'completed', step: 'stage_completed' }),
      mk({ stage: 'scribe', progress: 100, status: 'completed', step: 'stage_completed' }),
    ];
    const views = reduceStageViews(acts, acts[2]!, 'idle');
    expect(views[0]!.state).toBe('complete');
    expect(views[1]!.state).toBe('complete');
    expect(views[2]!.state).toBe('complete');
  });

  it('PR-V5: stage_completed for critic with criticPhase=spec folds into Scribe completion', () => {
    // The critic-phase routing applies to completion events too — a
    // critic_spec completion should mark the Scribe column complete
    // (not create a phantom Critic column).
    const acts: PipelineActivity[] = [
      mk({
        stage: 'critic',
        criticPhase: 'spec',
        progress: 100,
        status: 'completed',
        step: 'stage_completed',
      }),
      mk({ stage: 'proto', progress: 30 }),
    ];
    const views = reduceStageViews(acts, acts[1]!, 'proto_running');
    expect(views[0]!.state).toBe('complete'); // scribe (via critic spec)
    expect(views[1]!.state).toBe('active');
    expect(views[2]!.state).toBe('pending');
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

  // PR-V (tooltip-ux): bakkal-Türkçesi stage description moved from the
  // card's native `title=` attribute to a dedicated `?` StageInfoButton
  // popover. The card still exposes the description via `aria-label` for
  // screen readers — the native tooltip no longer fires (so it can't clash
  // with the ConfidenceBadge popover).
  it('exposes bakkal-Türkçesi stage description via aria-label (not native title)', () => {
    const { container } = render(<PipelineCinema activities={[]} currentStep={null} />);
    const stages: Array<{ name: string; expected: string }> = [
      { name: 'scribe', expected: "Fikri spec'e çevirir" },
      { name: 'proto', expected: "Spec'ten kod üretir" },
      { name: 'trace', expected: 'Otomatik test üretir' },
    ];
    for (const { name, expected } of stages) {
      const card = container.querySelector(`[data-stage="${name}"]`);
      expect(card, `card for ${name} should exist`).toBeTruthy();
      // aria-label still carries the description for a11y.
      expect(card?.getAttribute('aria-label')).toContain(expected);
      // Native title MUST be absent to avoid the two-tooltip clash.
      expect(card?.getAttribute('title')).toBeNull();
    }
  });

  // PR-V (tooltip-ux): each stage card has a `?` info button in the header
  // that opens a popover with the stage description on hover/focus/click.
  it('renders a stage-info button for each stage that reveals the description on hover', () => {
    render(<PipelineCinema activities={[]} currentStep={null} />);
    const stages: Array<{ name: 'scribe' | 'proto' | 'trace'; expected: string }> = [
      { name: 'scribe', expected: "Fikri spec'e çevirir" },
      { name: 'proto', expected: "Spec'ten kod üretir" },
      { name: 'trace', expected: 'Otomatik test üretir' },
    ];
    for (const { name, expected } of stages) {
      const btn = screen.getByTestId(`stage-info-${name}`);
      expect(btn).toBeInTheDocument();
      // Closed by default — no tooltip in the document for this stage.
      expect(btn).not.toHaveAttribute('aria-describedby');
      // Hover opens the popover for this stage.
      fireEvent.mouseEnter(btn);
      const ariaId = btn.getAttribute('aria-describedby');
      expect(ariaId).toBeTruthy();
      const popover = document.getElementById(ariaId!);
      expect(popover).not.toBeNull();
      expect(popover!).toHaveTextContent(expected);
      // Leave to close so the next iteration starts clean.
      fireEvent.mouseLeave(btn);
    }
  });

  it('closes the stage-info popover when Escape is pressed', () => {
    render(<PipelineCinema activities={[]} currentStep={null} />);
    const btn = screen.getByTestId('stage-info-scribe');
    fireEvent.mouseEnter(btn);
    expect(btn).toHaveAttribute('aria-describedby');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn).not.toHaveAttribute('aria-describedby');
  });

  // PR-V (tooltip-ux): badge's own popover must be back on the card — the
  // suppressTooltip=true prop on PipelineCinema's usage was removed because
  // the card no longer competes with a native `title=` tooltip.
  it('confidence badge inside the card exposes its own popover-trigger button (no longer suppressed)', () => {
    const acts: PipelineActivity[] = [
      mk({
        stage: 'scribe',
        progress: 100,
        reasoning: { decision: 'Approved', confidence: 88 },
      }),
    ];
    render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    // The badge re-renders as a <button> (popover-enabled) instead of a
    // plain <span> pill — the PR-E `suppressTooltip` workaround is gone.
    const badge = screen.getByRole('button', { name: /88%/ });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('cursor-help');
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
    const { queryByTestId } = render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    expect(queryByTestId('trace-retry-badge')).toBeNull();
  });

  // PR-F3 (2026-05-19): Critic iterate-loop badge — Proto column shows
  // "Critic düzeltiyor (n/max)" instead of trace's "Test deniyor".
  it('renders Critic retry badge on Proto column when critic iterate-loop active', () => {
    const acts: PipelineActivity[] = [
      mk({ stage: 'scribe', progress: 100 }),
      mk({ stage: 'proto', progress: 100, message: 'Kod hazır' }),
      mk({
        stage: 'critic',
        criticPhase: 'code',
        step: 'retry-trigger',
        retryCount: 2,
        progress: 80,
        message: 'Değerlendirme kritik bulgu raporladı — Proto yeniden çalışıyor (2/3)',
      }),
    ];
    render(<PipelineCinema activities={acts} currentStep={acts[2]!} />);
    const badge = screen.getByTestId('critic-retry-badge');
    expect(badge).toHaveTextContent(/Değerlendirme düzeltiyor/);
    expect(badge).toHaveTextContent(/2\/3/);
    // Trace column has no badge in this scenario.
    expect(screen.queryByTestId('trace-retry-badge')).toBeNull();
  });

  it('does NOT render Critic retry badge when no critic iterate-loop activity', () => {
    const acts: PipelineActivity[] = [mk({ stage: 'proto', progress: 100, message: 'Kod hazır' })];
    const { queryByTestId } = render(<PipelineCinema activities={acts} currentStep={acts[0]!} />);
    expect(queryByTestId('critic-retry-badge')).toBeNull();
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
