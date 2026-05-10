import { useEffect, useMemo, useState } from 'react';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';
import type { PipelineExplanation, RegressionReport } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import { PipelineCinema } from './PipelineCinema';
import { ExplanationPanel } from './ExplanationPanel';
import { AttentionBanner } from './AttentionBanner';
import { RegressionPanel } from './RegressionPanel';

export interface PipelineDetailRailProps {
  pipelineId: string | undefined;
  uiState: ConversationUIState;
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
  /**
   * F-04: when true, the rail stays mounted for completed pipelines even
   * if the in-memory activity buffer was lost (e.g. backend restart).
   * Without this, the user could no longer access the Akış / Açıklama /
   * Regresyon tabs for finished work. Derived from the workflow's
   * proto/trace output presence in the parent.
   *
   * TODO(F-03/NFR-1): remove `pipelineHasOutputs` prop after activity
   * persistence lands — once activities are restored from DB on reload,
   * the original `idle && activities.length === 0` short-circuit no
   * longer triggers for finished work and this opt-in becomes dead weight.
   */
  pipelineHasOutputs?: boolean;
  /** DI for tests — falls back to workflowsApi.getExplanation */
  explanationFetcher?: (id: string) => Promise<PipelineExplanation>;
  /** DI for tests — falls back to workflowsApi.getRegression */
  regressionFetcher?: (id: string) => Promise<RegressionReport>;
  className?: string;
}

type Tab = 'flow' | 'why' | 'regression';

// uiStates after which the regression confidence surface makes sense.
// Both root pipelines and iteration children settle into `idle` once
// finished — at that point the regression report is the user's "did it
// stay green?" answer.
const REGRESSION_VISIBLE_STATES: ConversationUIState[] = ['idle'];

const RUNNING_STATES: ConversationUIState[] = [
  'scribe_clarifying',
  'scribe_running',
  'scribe_revise',
  'critic_running',
  'proto_running',
  'trace_running',
  'ci_running',
];

const REASONING_VISIBLE_STATES: ConversationUIState[] = ['awaiting_approval'];

function isRunning(uiState: ConversationUIState): boolean {
  return RUNNING_STATES.includes(uiState);
}
function isExplainable(uiState: ConversationUIState): boolean {
  return REASONING_VISIBLE_STATES.includes(uiState);
}
function isRegressionVisible(
  uiState: ConversationUIState,
  hasActivities: boolean,
  pipelineHasOutputs: boolean
): boolean {
  // F-04: persisted outputs are also a valid trigger — RegressionPanel
  // fetches its report straight from the workflow record, so it works
  // fine even when the live activity buffer is empty (post-restart).
  return REGRESSION_VISIBLE_STATES.includes(uiState) && (hasActivities || pipelineHasOutputs);
}

/**
 * PipelineDetailRail — opt-in Level-4 rail between the chat header and the
 * message list. Auto-expands at meaningful moments (active pipeline → flow
 * tab; awaiting approval → why tab) but collapses out of the way during
 * idle/completed states. Inherits the project's design tokens so it lives
 * happily in both light and dark themes.
 */
export function PipelineDetailRail({
  pipelineId,
  uiState,
  activities,
  currentStep,
  pipelineHasOutputs = false,
  explanationFetcher,
  regressionFetcher,
  className,
}: PipelineDetailRailProps) {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [explanation, setExplanation] = useState<PipelineExplanation | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);

  const regressionVisible = isRegressionVisible(uiState, activities.length > 0, pipelineHasOutputs);
  // Keep the collapse contract from v0.7.0: collapse on idle. The
  // Regresyon tab is still clickable and renders content when the user
  // manually expands the rail; auto-expansion would clobber the chat
  // viewport every time a pipeline finishes.
  const autoCollapsed = !isRunning(uiState) && !isExplainable(uiState);
  const autoTab: Tab = isRunning(uiState) ? 'flow' : 'why';
  const effectiveCollapsed = collapsed ?? autoCollapsed;
  const effectiveTab = tab ?? autoTab;

  useEffect(() => {
    if (!pipelineId) return;
    if (effectiveCollapsed) return;
    if (effectiveTab !== 'why') return;
    let cancelled = false;
    const fetcher = explanationFetcher ?? workflowsApi.getExplanation;
    fetcher(pipelineId)
      .then((data) => {
        if (!cancelled) {
          setExplanation(data);
          setExplanationError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setExplanationError(err instanceof Error ? err.message : 'Açıklama yüklenemedi');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, effectiveCollapsed, effectiveTab, currentStep, explanationFetcher]);

  // Note: the regression report is fetched lazily by the embedded
  // `RegressionPanel` itself (via `regressionFetcher`). The rail does
  // not duplicate that effect — it only forwards the DI fetcher and
  // mounts the panel when the user activates the Regresyon tab.

  const attentionPoints = useMemo(() => explanation?.attentionPoints ?? [], [explanation]);
  const highSevCount = useMemo(
    () => attentionPoints.filter((p) => p.severity === 'high').length,
    [attentionPoints]
  );

  if (!pipelineId || pipelineId === 'pending') return null;
  // F-04: only fully hide the rail when the pipeline has *no* state to
  // surface — neither live activity nor persisted outputs. This keeps
  // the tabs reachable for completed pipelines whose activity buffer was
  // lost (e.g. backend restart). Tabs render their own empty states
  // gracefully when activities are absent.
  if (uiState === 'idle' && activities.length === 0 && !pipelineHasOutputs) return null;

  // Q2 A/B-test escape hatch: ?baseline=1 hides the entire Level-4 rail
  // so the same pipeline can be screenshotted with and without the
  // explainability surface. Used by docs/dogfooding/q2-likert-form.html.
  // Lives behind URL param + localStorage so participants don't need to
  // touch source. Persists across reloads for a smooth flow.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('baseline') === '1') {
      try {
        window.localStorage.setItem('akis.experiment.baseline', '1');
      } catch {
        /* private mode etc. — no-op */
      }
      return null;
    }
    if (params.get('baseline') === '0') {
      try {
        window.localStorage.removeItem('akis.experiment.baseline');
      } catch {
        /* no-op */
      }
    }
    try {
      if (window.localStorage.getItem('akis.experiment.baseline') === '1') {
        return null;
      }
    } catch {
      /* no-op */
    }
  }

  const tabBtnBase = 'rounded-md px-2.5 py-1 text-xs font-medium transition-colors';
  const tabBtnActive = 'bg-ak-primary/15 text-ak-primary ring-1 ring-inset ring-ak-primary/30';
  const tabBtnInactive = 'text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary';

  // Mini per-stage progress so a collapsed rail still answers "where is
  // the pipeline?" at a glance. Mirrors PipelineCinema's STAGE_ORDER /
  // colours but without bringing in the full component (smaller bundle,
  // independent of cinema layout choices).
  type MiniStage = 'scribe' | 'critic' | 'proto' | 'trace';
  const MINI_ORDER: MiniStage[] = ['scribe', 'critic', 'proto', 'trace'];
  const MINI_LABEL: Record<MiniStage, string> = {
    scribe: 'Scribe',
    critic: 'Critic',
    proto: 'Proto',
    trace: 'Trace',
  };
  const stageOf = (a: PipelineActivity): MiniStage | null => {
    switch (a.stage) {
      case 'scribe':
      case 'critic':
      case 'trace':
        return a.stage;
      case 'proto':
      case 'fix-loop':
        return 'proto';
      default:
        return null;
    }
  };
  const lastStage: MiniStage | null = (() => {
    if (currentStep) {
      const s = stageOf(currentStep);
      if (s) return s;
    }
    for (let i = activities.length - 1; i >= 0; i--) {
      const s = stageOf(activities[i]!);
      if (s) return s;
    }
    return null;
  })();
  const lastIdx = lastStage ? MINI_ORDER.indexOf(lastStage) : -1;
  const stateOf = (idx: number): 'pending' | 'active' | 'complete' => {
    if (lastIdx === -1) return 'pending';
    if (idx < lastIdx) return 'complete';
    if (idx === lastIdx) {
      const isRunningState = isRunning(uiState);
      return isRunningState ? 'active' : 'complete';
    }
    return 'pending';
  };
  const dotClass = (stage: MiniStage, state: 'pending' | 'active' | 'complete') => {
    const base = 'h-1.5 w-1.5 rounded-full';
    if (state === 'pending') return `${base} bg-ak-border opacity-60`;
    const colour =
      stage === 'scribe'
        ? 'bg-ak-scribe'
        : stage === 'critic'
          ? 'bg-rose-400'
          : stage === 'proto'
            ? 'bg-ak-proto'
            : 'bg-ak-trace';
    return `${base} ${colour} ${state === 'active' ? 'animate-pulse' : ''}`;
  };

  return (
    <section
      aria-label="Pipeline detayı"
      data-collapsed={effectiveCollapsed}
      data-active-tab={effectiveTab}
      className={`border-b border-ak-border bg-ak-bg-panel ${className ?? ''}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => (c === null ? !autoCollapsed : !c))}
            aria-expanded={!effectiveCollapsed}
            aria-controls="pipeline-rail-body"
            className="rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wider text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
          >
            <span aria-hidden="true" className="inline-block w-3 text-ak-text-tertiary">
              {effectiveCollapsed ? '▸' : '▾'}
            </span>{' '}
            Pipeline detayı
          </button>
          {!effectiveCollapsed && (
            <div role="tablist" className="flex gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={effectiveTab === 'flow'}
                onClick={() => setTab('flow')}
                className={`${tabBtnBase} ${effectiveTab === 'flow' ? tabBtnActive : tabBtnInactive}`}
              >
                Akış
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveTab === 'why'}
                onClick={() => setTab('why')}
                className={`${tabBtnBase} ${effectiveTab === 'why' ? tabBtnActive : tabBtnInactive}`}
              >
                Açıklama
              </button>
              {regressionVisible && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === 'regression'}
                  onClick={() => setTab('regression')}
                  className={`${tabBtnBase} ${effectiveTab === 'regression' ? tabBtnActive : tabBtnInactive}`}
                >
                  Regresyon
                </button>
              )}
            </div>
          )}
          {effectiveCollapsed && (
            <span aria-label="Pipeline durumu" className="ml-1 flex items-center gap-1.5">
              {MINI_ORDER.map((s, idx) => {
                const state = stateOf(idx);
                return (
                  <span
                    key={s}
                    className={dotClass(s, state)}
                    title={`${MINI_LABEL[s]} — ${state}`}
                    data-stage={s}
                    data-state={state}
                  />
                );
              })}
            </span>
          )}
        </div>
        {!effectiveCollapsed && attentionPoints.length > 0 && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
              highSevCount > 0
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
            aria-label={`${attentionPoints.length} dikkat noktası`}
          >
            <span aria-hidden="true">!</span>
            {attentionPoints.length} dikkat noktası
          </span>
        )}
      </header>
      {!effectiveCollapsed && (
        <div
          id="pipeline-rail-body"
          tabIndex={0}
          role="region"
          aria-label="Pipeline detayı içeriği"
          className="max-h-[55vh] overflow-y-auto overscroll-contain px-4 pb-3 sm:max-h-[60vh]"
        >
          {attentionPoints.length > 0 && (
            <div className="mb-3">
              <AttentionBanner points={attentionPoints} limit={2} />
            </div>
          )}
          {effectiveTab === 'flow' && (
            <PipelineCinema activities={activities} currentStep={currentStep} compact />
          )}
          {effectiveTab === 'why' && (
            <>
              {explanationError && (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200"
                >
                  {explanationError}
                </div>
              )}
              {!explanationError && (
                <ExplanationPanel
                  pipelineId={pipelineId}
                  explanation={explanation ?? undefined}
                  fetcher={explanationFetcher}
                  hideAttentionBanner
                />
              )}
            </>
          )}
          {effectiveTab === 'regression' && (
            <RegressionPanel pipelineId={pipelineId} fetcher={regressionFetcher} />
          )}
        </div>
      )}
    </section>
  );
}

export default PipelineDetailRail;
