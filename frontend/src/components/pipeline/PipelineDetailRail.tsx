import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';
import type {
  CriticReviewOutput,
  PipelineExplanation,
  RegressionReport,
} from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import { PipelineCinema } from './PipelineCinema';
import { ExplanationPanel } from './ExplanationPanel';
import { AttentionBanner } from './AttentionBanner';
import { RegressionPanel } from './RegressionPanel';
import { PushConfirmGate } from './PushConfirmGate';
import { CriticResolutionGate } from './CriticResolutionGate';
import { AiCallsPanel } from './AiCallsPanel';
import type { AiCallEntry } from '../../types/pipeline';

export interface PipelineDetailRailProps {
  pipelineId: string | undefined;
  uiState: ConversationUIState;
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
  /**
   * PDP-3 B4: cached scaffold files used by the inline preview when the
   * pipeline halts at `awaiting_push_confirm`. Resolved by the parent via
   * `useProtoFiles`. When the gate isn't active this prop is ignored.
   */
  protoFiles?: Record<string, string> | null;
  /**
   * PDP-3 B4: invoked after confirm-push / cancel-push so the parent can
   * trigger a workflow refetch (the orchestrator transitions stages
   * asynchronously so polling needs a nudge).
   */
  onPushResolved?: () => void;
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
  /**
   * PDP-3 T2: whether the right-side Preview Panel is currently visible.
   * Used by the compact PushConfirmGate to decide whether to offer the
   * "Önizlemeyi aç" fallback button. Threaded from ChatPageLayout (which
   * owns the showPreview state).
   */
  showPreview?: boolean;
  /**
   * PDP-3 T2: open the right Preview Panel. Invoked by the gate's
   * "Önizlemeyi aç" button when previewOpen is false.
   */
  onTogglePreview?: () => void;
  /** DI for tests — falls back to workflowsApi.getExplanation */
  explanationFetcher?: (id: string) => Promise<PipelineExplanation>;
  /** DI for tests — falls back to workflowsApi.getRegression */
  regressionFetcher?: (id: string) => Promise<RegressionReport>;
  /** P5b — DI for tests; falls back to workflowsApi.getAiCalls */
  aiCallsFetcher?: (id: string) => Promise<AiCallEntry[]>;
  /**
   * P5b — visibility override for the AI logs tab. When undefined, the tab
   * is gated by `isInternalUiVisible()` (URL `?debug=1`, localStorage
   * `akis_debug=true`, or build-time `VITE_SHOW_INTERNAL_UI=true`). Tests
   * pass an explicit boolean so behavior is deterministic.
   */
  showAiLogsTab?: boolean;
  /**
   * P8 — latest Critic code-review output. Required to render the
   * `CriticResolutionGate` while the pipeline is at
   * `awaiting_critic_resolution`. Threaded down from the host page
   * (chat layout reads it from `pipeline.intermediateState.criticCodeOutput`).
   */
  criticReview?: CriticReviewOutput;
  /** P8 — approval threshold from backend env, defaults to 75. */
  criticApprovalThreshold?: number;
  /**
   * P8 — invoked after `critic-override` resolves so the parent can refresh
   * pipeline state. Mirrors `onPushResolved`.
   */
  onCriticResolved?: () => void;
  /**
   * PR-D — per-AC binary coverage report sourced from
   * `pipeline.intermediateState.acCoverage`. Passed straight through to
   * ExplanationPanel; the Proto reasoning card uses it to render the
   * checklist in place of the confidence-bullet list.
   */
  acCoverage?: import('../../types/pipeline').AcCoverageReport;
  className?: string;
}

type Tab = 'flow' | 'why' | 'regression' | 'aiLogs';

/**
 * P5b — internal-UI gate for the AI Logs tab. Mirrors the same three-way
 * trigger as PreviewPanel's console (URL ?debug=1, localStorage flag, or
 * build-time env var). Re-implemented locally instead of importing so this
 * file stays free of cross-feature coupling.
 */
function isInternalUiVisible(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('debug') === '1') return true;
    if (window.localStorage?.getItem('akis_debug') === 'true') return true;
  } catch {
    // SecurityError under privacy-mode sandboxing — fall through.
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any)?.env;
  return env?.VITE_SHOW_INTERNAL_UI === 'true';
}

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

// PDP-3 B4: the push gate is just as "needs your input now" as
// `awaiting_approval` — auto-expand the rail and surface its UI inline.
const PUSH_GATE_STATES: ConversationUIState[] = ['awaiting_push_confirm'];

// P8: critic hard-block — same "needs your input now" gravity as the push
// gate; auto-expand so the score bar + resolution buttons are immediately
// visible.
const CRITIC_GATE_STATES: ConversationUIState[] = ['awaiting_critic_resolution'];

function isRunning(uiState: ConversationUIState): boolean {
  return RUNNING_STATES.includes(uiState);
}
function isExplainable(uiState: ConversationUIState): boolean {
  return REASONING_VISIBLE_STATES.includes(uiState);
}
function isPushGate(uiState: ConversationUIState): boolean {
  return PUSH_GATE_STATES.includes(uiState);
}
function isCriticGate(uiState: ConversationUIState): boolean {
  return CRITIC_GATE_STATES.includes(uiState);
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
  aiCallsFetcher,
  showAiLogsTab,
  protoFiles,
  showPreview,
  onTogglePreview,
  criticReview,
  criticApprovalThreshold,
  onCriticResolved,
  acCoverage,
  className,
  // onPushResolved is accepted in the interface so callers can keep
  // passing it (it's still consumed by the T1 PushGateFooter render path,
  // owned by ChatPageLayout). The rail itself no longer drives push
  // confirm/cancel — those moved out of the chat card.
}: PipelineDetailRailProps) {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [explanation, setExplanation] = useState<PipelineExplanation | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  // PR-B (user feedback 2026-05-15 ek #2): user-controllable rail body
  // height. `null` → fall back to the `max-h-[55vh]/[60vh]` Tailwind
  // tokens (the original sizing). A number means the user dragged the
  // handle and we apply an explicit max-height in pixels instead. Bounds
  // are enforced on every drag tick (see RAIL_MIN_HEIGHT_PX +
  // RAIL_MAX_HEIGHT_VH) so the rail can never collapse to zero or eat
  // the chat surface beneath it.
  const [bodyHeightPx, setBodyHeightPx] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const regressionVisible = isRegressionVisible(uiState, activities.length > 0, pipelineHasOutputs);
  const pushGateActive = isPushGate(uiState);
  const criticGateActive = isCriticGate(uiState);
  // P5b: AI logs tab is internal-only. Parent can override (tests + future
  // admin-role plumbing); fall back to URL/localStorage/env gate.
  const aiLogsTabVisible = showAiLogsTab ?? isInternalUiVisible();
  // Keep the collapse contract from v0.7.0: collapse on idle. The
  // Regresyon tab is still clickable and renders content when the user
  // manually expands the rail; auto-expansion would clobber the chat
  // viewport every time a pipeline finishes. PDP-3 B4 + P8 add the push +
  // critic gates to the auto-expand set so the user can't miss the inline
  // resolution surface.
  const autoCollapsed =
    !isRunning(uiState) && !isExplainable(uiState) && !pushGateActive && !criticGateActive;
  // PR-B: push + critic gates render their inline action UI inside the
  // Akış tab (alongside the cinema). Auto-route to 'flow' for those so the
  // gate is immediately reachable — otherwise the user lands on Açıklama
  // (where we no longer surface the gates) and has to click around to find
  // the resolve button.
  const autoTab: Tab =
    isRunning(uiState) || pushGateActive || criticGateActive ? 'flow' : 'why';
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

  // PR-B: vertical resize handle. Mirrors the chat ↔ preview split-pane
  // pattern from useSplitResize (mousedown → document mousemove/up + a
  // ref to track drag state) but applied to the rail body's height.
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const currentH = bodyRef.current?.offsetHeight ?? 0;
    if (currentH <= 0) return;
    dragRef.current = { startY: e.clientY, startHeight: currentH };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    // PR-E bulgu #3: previous bounds (120px / 70vh) left users complaining
    // that the rail couldn't shrink small enough to give the chat surface
    // back. Drop the floor to 60px (just the tab strip + a sliver of body)
    // and lift the ceiling to 85vh so power-users can fill the column
    // while still leaving a chat handle visible.
    const RAIL_MIN_HEIGHT_PX = 60;
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const { startY, startHeight } = dragRef.current;
      const dy = ev.clientY - startY;
      const max = Math.round(window.innerHeight * 0.85);
      const next = Math.max(RAIL_MIN_HEIGHT_PX, Math.min(max, startHeight + dy));
      setBodyHeightPx(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

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
              {aiLogsTabVisible && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === 'aiLogs'}
                  onClick={() => setTab('aiLogs')}
                  className={`${tabBtnBase} ${effectiveTab === 'aiLogs' ? tabBtnActive : tabBtnInactive}`}
                >
                  AI Logları
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
          ref={bodyRef}
          id="pipeline-rail-body"
          tabIndex={0}
          role="region"
          aria-label="Pipeline detayı içeriği"
          // PR-B: when the user drags the resize handle we apply an
          // explicit pixel maxHeight; otherwise the original vh tokens
          // win (preserving the F-02 scrollability + breakpoint
          // contract). The drag clamp is min 120px / max 70vh — see
          // handleResizeStart.
          className="overflow-y-auto overscroll-contain px-4 pb-3 max-h-[55vh] sm:max-h-[60vh]"
          style={bodyHeightPx !== null ? { maxHeight: `${bodyHeightPx}px` } : undefined}
        >
          {/* PR-B (user feedback 2026-05-15 #5): AttentionBanner +
              CriticResolutionGate are scoped to the Akış tab. Previously
              they rendered above both tabs, which made the Açıklama tab
              top with the same red/amber banners users already see in Akış
              — duplicate noise, less room for the per-stage reasoning
              cards that Açıklama is actually meant to surface.
              PushConfirmGate stays above-the-fold so the user can resolve
              it regardless of which tab is open. */}
          {effectiveTab === 'flow' && attentionPoints.length > 0 && (
            <div className="mb-3">
              <AttentionBanner points={attentionPoints} limit={2} />
            </div>
          )}
          {pushGateActive && pipelineId && (
            <div className="mb-3">
              <PushConfirmGate
                pipelineId={pipelineId}
                fileCount={protoFiles ? Object.keys(protoFiles).length : 0}
                previewOpen={showPreview ?? false}
                onOpenPreview={() => onTogglePreview?.()}
              />
            </div>
          )}
          {effectiveTab === 'flow' && criticGateActive && pipelineId && criticReview && (
            <div className="mb-3">
              <CriticResolutionGate
                pipelineId={pipelineId}
                criticReview={criticReview}
                approvalThreshold={criticApprovalThreshold}
                onResolved={() => onCriticResolved?.()}
              />
            </div>
          )}
          {effectiveTab === 'flow' && (
            <PipelineCinema
              activities={activities}
              currentStep={currentStep}
              uiState={uiState}
              compact
            />
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
                  onIterationStarted={onCriticResolved}
                  acCoverage={acCoverage}
                />
              )}
            </>
          )}
          {effectiveTab === 'regression' && (
            <RegressionPanel pipelineId={pipelineId} fetcher={regressionFetcher} />
          )}
          {effectiveTab === 'aiLogs' && aiLogsTabVisible && (
            <AiCallsPanel pipelineId={pipelineId} fetcher={aiCallsFetcher} />
          )}
        </div>
      )}
      {/* PR-B (user feedback 2026-05-15 ek #2): vertical drag handle
          between the rail and the chat below. Mirrors the chat ↔ preview
          horizontal handle pattern in ChatPageLayout (line ~327): same
          design tokens, same group-hover affordance, same body cursor
          override. Hidden when the rail is collapsed — no body to
          resize. Hidden under md to match the project's mobile posture
          (the chat-preview split also hides its handle under lg). */}
      {!effectiveCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Pipeline detayı yüksekliğini ayarla"
          aria-controls="pipeline-rail-body"
          data-testid="pipeline-rail-resize-handle"
          className="group hidden h-1 w-full flex-shrink-0 cursor-row-resize bg-ak-border transition-colors hover:bg-ak-primary/50 active:bg-ak-primary md:block"
          title="Sürükleyerek yüksekliği ayarla"
        >
          <div className="flex h-full items-center justify-center">
            <div className="h-0.5 w-8 rounded-full bg-ak-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
      )}
    </section>
  );
}

export default PipelineDetailRail;
