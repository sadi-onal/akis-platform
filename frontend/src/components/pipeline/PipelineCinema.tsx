import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';
import { ConfidenceBadge } from './ConfidenceBadge';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useI18n } from '../../i18n/useI18n';
import { reduceStageViews, type CinemaStage, type StageView } from './PipelineCinema.utils';

export interface PipelineCinemaProps {
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
  /**
   * Orchestrator-level state — drives which column is "live". Without it
   * we fall back to the latest activity's stage, which leaves a column
   * pulsing forever at approval/push gates because the SSE buffer never
   * emits a "stage finished" marker.
   */
  uiState?: ConversationUIState;
  /** Compact mode hides the full-screen takeover; the row stays visible. */
  compact?: boolean;
  /** Callback when user toggles compact mode */
  onToggleCompact?: () => void;
  /** Slot rendered below the four-column row — typically the approval gate. */
  approvalSlot?: React.ReactNode;
  className?: string;
}

// PR-F (2026-05-19): Cinema 5 column → 3 column refactor. Critic ana akıştan
// guardrail'e çekildi; bulgular CriticFindingsInline (Proto kartı altında)
// ve ExplanationPanel'de gösterilir. Kalan 3 column klasik Scribe → Proto →
// Trace zinciri.
const STAGE_LABEL: Record<CinemaStage, string> = {
  scribe: 'Scribe',
  proto: 'Proto',
  trace: 'Trace',
};

const STAGE_TAGLINE: Record<CinemaStage, string> = {
  scribe: 'Fikir → Spec',
  proto: 'Spec → Kod',
  trace: 'Kod → Test',
};

// PR-A Fix 3: bakkal-Türkçesi hover tooltips for the cinema columns. Mirror
// the wording in the explanation rail so the same vocabulary describes
// each agent everywhere. Falls back to the constant below if i18n is not
// ready (e.g. in unit tests).
const STAGE_TOOLTIP_FALLBACK: Record<CinemaStage, string> = {
  scribe: "Fikri spec'e çevirir — kabul kriterleri ve kullanıcı hikayeleri",
  proto: "Spec'ten kod üretir — proje iskeleti ve uygulama dosyaları",
  trace: 'Otomatik test üretir; eksik kabul kriteri varsa Proto yeniden çalıştırılır',
};

// Per-agent identity colours. Scribe/Proto/Trace match the rest of the app
// (see tailwind config: ak-scribe/proto/trace tokens).
const STAGE_ACCENT: Record<CinemaStage, { dot: string; ring: string; tint: string; text: string }> =
  {
    scribe: {
      dot: 'bg-ak-scribe',
      ring: 'border-ak-scribe/60 shadow-[0_0_0_1px_rgb(56_189_248/0.25)]',
      tint: 'bg-ak-scribe/5',
      text: 'text-ak-scribe',
    },
    proto: {
      dot: 'bg-ak-proto',
      ring: 'border-ak-proto/60 shadow-[0_0_0_1px_rgb(245_158_11/0.25)]',
      tint: 'bg-ak-proto/5',
      text: 'text-ak-proto',
    },
    trace: {
      dot: 'bg-ak-trace',
      ring: 'border-ak-trace/60 shadow-[0_0_0_1px_rgb(167_139_250/0.25)]',
      tint: 'bg-ak-trace/5',
      text: 'text-ak-trace',
    },
  };

// PR-A Fix 3: i18n keys for the tooltips. Kept as a separate map so the
// translation key lookup is a single read in StageColumn.
const STAGE_TOOLTIP_KEY: Record<CinemaStage, string> = {
  scribe: 'pipeline.stage.scribe.tooltip',
  proto: 'pipeline.stage.proto.tooltip',
  trace: 'pipeline.stage.trace.tooltip',
};

/**
 * StageInfoButton — small "?" trigger that opens a popover with the stage
 * description. Replaces the card's old native `title` attribute, which used
 * to clash with the ConfidenceBadge's own popover (two tooltips stacked on
 * hover). By giving the stage description its own discrete trigger element,
 * the badge's popover can stay enabled without competing for the same hover
 * surface.
 *
 * PR-V (tooltip-ux): accessible — keyboard focus + Escape + outside-click.
 */
function StageInfoButton({
  label,
  description,
  stage,
}: {
  /** Visible stage name used for the aria-label, e.g. "Scribe". */
  label: string;
  /** Türkçe açıklama metni. */
  description: string;
  /** Stage id, used to namespace the popover id + test selectors. */
  stage: CinemaStage;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        data-testid={`stage-info-${stage}`}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? id : undefined}
        aria-label={`${label}: ${description}`}
        // Visual: subtle circular question-mark, large enough to be a tap
        // target but small enough not to dominate the header. Same tier of
        // affordance as the ConfidenceBadge (rounded-full, border, cursor-help).
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-ak-border-default text-[10px] font-semibold leading-none text-ak-text-tertiary transition hover:border-ak-border-strong hover:text-ak-text-secondary"
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        // Anchored to the LEFT edge of the button so the popover extends
        // rightward into the column — the info button lives on the left side
        // of the header (next to the stage label), and the column to its
        // right has plenty of room. `min(16rem, 90vw)` keeps it readable on
        // very narrow viewports.
        <span
          id={id}
          role="tooltip"
          style={{ maxWidth: 'min(16rem, 90vw)' }}
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-ak-border bg-ak-surface p-2 text-xs leading-relaxed text-ak-text-secondary shadow-lg"
        >
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ak-text-tertiary">
            {label}
          </span>
          {description}
        </span>
      )}
    </span>
  );
}

function StageColumn({
  view,
  reducedMotion,
  tooltip,
}: {
  view: StageView;
  reducedMotion: boolean;
  /** PR-A Fix 3: bakkal-Türkçesi hover text describing what this stage does.
   * PR-V (tooltip-ux): no longer passed to a native `title=` attribute on
   * the card (which clashed with the ConfidenceBadge's own popover). It now
   * feeds the StageInfoButton's popover only. The card itself retains the
   * description via `aria-label` for screen readers. */
  tooltip: string;
}) {
  // PR-V5: `progress` removed from the destructure — the bar is now
  // indeterminate (shimmer) when active and full when complete; the
  // numeric percent on a `StageView` is kept on the type for back-compat
  // with the rail/explainability rail but no longer drives the UI here.
  const { stage, state, latest, reasoning, meta } = view;
  const accent = STAGE_ACCENT[stage];
  const messageText = latest?.message ?? '';
  const baseClass =
    'flex min-h-[160px] flex-col gap-2 rounded-xl border bg-ak-surface p-3 transition-all';
  const stateClass =
    state === 'active'
      ? `${accent.ring} ${accent.tint}`
      : state === 'complete'
        ? 'border-ak-border-default'
        : 'border-ak-border-subtle opacity-60';
  // PR-F: Trace iterate-loop retry rozetinin gösterileceği koşul. retryCount
  // tanımlı ise (en az 1 retry tetiklenmişse) badge görünür; max bilinmiyorsa
  // sadece "Test deniyor (n)" formatında düşer.
  // PR-F3 (2026-05-19): Critic critical-finding iterate-loop için aynı meta
  // shape kullanılır; Critic retry'ı Proto column'unda "Critic düzeltiyor
  // (n/max)" olarak gösterilir (`meta.retrySource === 'critic'`).
  const showRetryBadge =
    meta?.retryCount !== undefined &&
    meta.retryCount > 0 &&
    ((stage === 'trace' && meta.retrySource !== 'critic') ||
      (stage === 'proto' && meta.retrySource === 'critic'));
  const retryLabel = (() => {
    if (!showRetryBadge || !meta) return null;
    if (stage === 'proto' && meta.retrySource === 'critic') {
      // T5: display-only rename — Critic → Değerlendirme
      return meta.maxRetries
        ? `Değerlendirme düzeltiyor (${meta.retryCount}/${meta.maxRetries})`
        : `Değerlendirme düzeltiyor (${meta.retryCount})`;
    }
    return meta.maxRetries
      ? `Test deniyor (${meta.retryCount}/${meta.maxRetries})`
      : `Test deniyor (${meta.retryCount})`;
  })();
  const retryBadge = retryLabel;
  const retryBadgeTestId =
    stage === 'proto' && meta?.retrySource === 'critic'
      ? 'critic-retry-badge'
      : 'trace-retry-badge';
  return (
    <div
      data-stage={stage}
      data-state={state}
      className={`${baseClass} ${stateClass}`}
      // PR-V (tooltip-ux): no `title=` here. The native browser tooltip used
      // to fire alongside the ConfidenceBadge's popover, producing the
      // "two-tooltips-on-hover" clash. Stage description is now reached via
      // the dedicated `?` StageInfoButton in the header. `aria-label` still
      // describes the column to screen readers.
      aria-label={tooltip}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${accent.dot} ${
              state === 'active' && !reducedMotion ? 'animate-pulse' : ''
            } ${state === 'pending' ? 'opacity-40' : ''}`}
          />
          <span className={`text-sm font-semibold ${accent.text}`}>{STAGE_LABEL[stage]}</span>
          <StageInfoButton label={STAGE_LABEL[stage]} description={tooltip} stage={stage} />
        </span>
        <span className="flex items-center gap-1.5">
          {retryBadge && (
            <span
              data-testid={retryBadgeTestId}
              className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-400/10 px-1.5 py-0 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
              aria-label={retryBadge}
            >
              {retryBadge}
            </span>
          )}
          {reasoning?.confidence !== undefined && (
            // PR-V (tooltip-ux): badge's own popover re-enabled. The card no
            // longer competes with a native `title=` tooltip — the stage
            // description now lives behind the dedicated `?` button — so
            // hovering the badge cleanly opens its tier-explanation popover.
            <ConfidenceBadge score={reasoning.confidence} compact />
          )}
        </span>
      </header>
      <p className="text-xs text-ak-text-tertiary">{STAGE_TAGLINE[stage]}</p>
      {state !== 'pending' && (
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--ak-border-subtle)' }}
        >
          {/* PR-V5: active stages show an indeterminate shimmer instead of a
              fake percentage. The old `width: ${progress}%` would sit at 0%
              the whole stage and then jump to 100% on transition, because
              the orchestrator rarely sets `progress`. Completed stages
              stay at a full bar. `prefers-reduced-motion` collapses the
              shimmer to a static 40% wide indicator. */}
          {state === 'active' ? (
            <div
              className={accent.dot}
              data-testid={`stage-progress-${stage}`}
              data-state="active"
              style={
                reducedMotion
                  ? { height: '100%', width: '40%' }
                  : {
                      height: '100%',
                      width: '40%',
                      animation: 'ak-indeterminate 1.4s ease-in-out infinite',
                    }
              }
            />
          ) : (
            <div
              className={accent.dot}
              data-testid={`stage-progress-${stage}`}
              data-state="complete"
              style={{ height: '100%', width: '100%' }}
            />
          )}
        </div>
      )}
      {messageText && (
        <p
          className={`text-xs leading-snug ${
            state === 'pending' ? 'text-ak-text-tertiary' : 'text-ak-text-primary'
          }`}
          aria-live="polite"
        >
          {messageText}
        </p>
      )}
      {reasoning?.decision && (
        <div className="mt-auto rounded-md border border-ak-border-subtle bg-ak-surface-2 p-2 text-xs">
          <p className="font-semibold text-ak-text-primary">{reasoning.decision}</p>
          {reasoning.snippet && (
            <p className="mt-0.5 line-clamp-3 text-ak-text-tertiary">{reasoning.snippet}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * PipelineCinema — theatrical, four-column live view of an active pipeline.
 * Designed for thesis demos and onboarding. Operates purely on the SSE
 * activity stream; no extra round-trips. Falls back to a compact row when
 * `compact` is set so power users can collapse it.
 */
export function PipelineCinema({
  activities,
  currentStep,
  uiState,
  compact = false,
  onToggleCompact,
  approvalSlot,
  className,
}: PipelineCinemaProps) {
  const reducedMotion = useReducedMotion();
  const i18n = useI18n();
  const views = useMemo(
    () => reduceStageViews(activities, currentStep, uiState),
    [activities, currentStep, uiState]
  );

  const tooltipFor = (stage: CinemaStage): string => {
    // i18n.t expects a MessageKey, but we type the map as plain strings to
    // keep the file self-contained. Cast through `unknown` so missing keys
    // are caught by the i18n provider's warnMissingKey path instead of
    // breaking the build when the catalogue lags behind.
    const key = STAGE_TOOLTIP_KEY[stage] as unknown as Parameters<typeof i18n.t>[0];
    const translated = i18n.t(key);
    // When the key is missing the provider returns the key string itself;
    // detect that and fall back to the hardcoded Turkish copy so users
    // never see a raw key in the tooltip.
    return translated === STAGE_TOOLTIP_KEY[stage] ? STAGE_TOOLTIP_FALLBACK[stage] : translated;
  };

  return (
    <section
      aria-label="Pipeline canlı görüntüsü"
      data-cinema-mode={compact ? 'compact' : 'full'}
      className={`flex flex-col gap-3 ${className ?? ''}`}
    >
      {/* When the consumer renders its own header (e.g. PipelineDetailRail
          puts "Pipeline detayı" with the Akış/Açıklama tabs above us) we
          omit our own subtitle to avoid two tracking-wide caps headers
          stacked on top of each other. The header only renders when
          there's a compact toggle to attach to. */}
      {onToggleCompact && (
        <header className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ak-text-tertiary">
            {i18n.t('pipeline.cinema.title')}
          </h2>
          <button
            type="button"
            onClick={onToggleCompact}
            className="rounded-md border border-ak-border bg-ak-surface px-2 py-1 text-xs text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
            aria-pressed={compact}
          >
            {compact
              ? i18n.t('pipeline.cinema.toggleWide')
              : i18n.t('pipeline.cinema.toggleCompact')}
          </button>
        </header>
      )}
      {/* PR-F: 3 columns (Scribe · Proto · Trace). Critic ana akıştan
          guardrail'e çekildiğinden bulgular ayrı kart olarak değil,
          CriticFindingsInline + ExplanationPanel üzerinden gösteriliyor.
          Mobil compact: 2 column → genişledikçe 3. */}
      <div
        className={`grid gap-2 ${
          compact ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
        }`}
      >
        {views.map((v) => (
          <StageColumn
            key={v.stage}
            view={v}
            reducedMotion={reducedMotion}
            tooltip={tooltipFor(v.stage)}
          />
        ))}
      </div>
      {approvalSlot && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-3">
          {approvalSlot}
        </div>
      )}
    </section>
  );
}

export default PipelineCinema;
