import { useEffect, useMemo, useState } from 'react';
import type {
  PipelineExplanation,
  AgentReasoning,
  ReasoningFinding,
  AcCoverageReport,
} from '../../types/pipeline';
import type { StructuredSpec, Workflow } from '../../types/workflow';
import { workflowsApi } from '../../services/api/workflows';
import { useI18n } from '../../i18n/useI18n';
import { ConfidenceBadge } from './ConfidenceBadge';
import { AcCoverageChecklist } from './AcCoverageChecklist';
import { ScribeOutputDisclosures } from './ScribeOutputDisclosures';
import { IterationTrajectory } from './IterationTrajectory';

// Hard ceiling enforced by the backend feedback schema (B5,
// `IterateFeedbackRequestSchema.feedback.max(2000)`). We mirror it
// client-side so very long aggregated suggestions don't 400 on submit.
const FEEDBACK_MAX_CHARS = 2000;

// Per-category surface metadata. Icons are simple text glyphs (not
// emoji) so they stay legible across systems and don't fight the AKIS
// type system. Order intentionally matches Critic's review weights:
// completeness → ambiguity → testability → consistency → spec_compliance → security.
const CATEGORY_META: Record<
  ReasoningFinding['category'],
  { label: string; icon: string; tint: string }
> = {
  completeness: {
    label: 'Eksiklik',
    icon: '◌',
    tint: 'border-sky-400/40 bg-sky-500/5',
  },
  ambiguity: {
    label: 'Belirsizlik',
    icon: '?',
    tint: 'border-amber-400/40 bg-amber-500/5',
  },
  testability: {
    label: 'Test edilebilirlik',
    icon: '↗',
    tint: 'border-violet-400/40 bg-violet-500/5',
  },
  consistency: {
    label: 'Tutarlılık',
    icon: '⇆',
    tint: 'border-fuchsia-400/40 bg-fuchsia-500/5',
  },
  spec_compliance: {
    label: 'Spec uyumu',
    icon: '✓',
    tint: 'border-emerald-400/40 bg-emerald-500/5',
  },
  security: {
    label: 'Güvenlik',
    icon: '!',
    tint: 'border-rose-400/40 bg-rose-500/5',
  },
};

const SEVERITY_META: Record<ReasoningFinding['severity'], { label: string; chip: string }> = {
  critical: {
    label: 'Kritik',
    chip: 'bg-rose-500/15 text-rose-700 border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200 dark:border-rose-500/30',
  },
  major: {
    label: 'Önemli',
    chip: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  },
  minor: {
    label: 'Küçük',
    chip: 'bg-slate-500/10 text-slate-700 border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-200 dark:border-slate-500/30',
  },
  info: {
    label: 'Bilgi',
    chip: 'bg-ak-surface-2 text-ak-text-secondary border-ak-border-subtle',
  },
};

const SEVERITY_RANK: Record<ReasoningFinding['severity'], number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

interface CriticFindingsSectionProps {
  findings: ReasoningFinding[];
  /**
   * PR-C: when provided, every finding that ships a non-empty `suggestion`
   * gets a checkbox + the section renders an "Apply selected" footer that
   * bundles the chosen suggestions and POSTs them through
   * `workflowsApi.iterateWithFeedback` (or the injected fetcher). Without a
   * pipelineId, the section stays read-only — keeps standalone usage on
   * legacy pages clean.
   */
  pipelineId?: string;
  /** Invoked after a successful iterate so the host can refresh state. */
  onIterationStarted?: () => void;
  /** DI for tests — defaults to `workflowsApi.iterateWithFeedback`. */
  iterateWithFeedback?: (id: string, feedback: string) => Promise<unknown>;
}

/**
 * Stable per-finding key built from category + index inside its group.
 * Findings don't ship a server-side ID, but the order is deterministic
 * per render and we group/sort the same way each pass, so this works as
 * a selection token between renders. Switching to a content hash would
 * survive list reorderings but adds complexity without a known need.
 */
function findingKey(category: string, indexInCategory: number): string {
  return `${category}::${indexInCategory}`;
}

export function CriticFindingsSection({
  findings,
  pipelineId,
  onIterationStarted,
  iterateWithFeedback,
}: CriticFindingsSectionProps) {
  const { t } = useI18n();
  // Group by category, then sort each group by severity (worst first).
  const { orderedCats, groupedByCat, eligibleKeys } = useMemo(() => {
    const byCategory = new Map<ReasoningFinding['category'], ReasoningFinding[]>();
    for (const f of findings) {
      if (!byCategory.has(f.category)) byCategory.set(f.category, []);
      byCategory.get(f.category)!.push(f);
    }
    for (const list of byCategory.values()) {
      list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    }
    const cats = Array.from(byCategory.keys()).sort((a, b) => {
      const aMin = Math.min(...byCategory.get(a)!.map((f) => SEVERITY_RANK[f.severity]));
      const bMin = Math.min(...byCategory.get(b)!.map((f) => SEVERITY_RANK[f.severity]));
      return aMin - bMin || a.localeCompare(b);
    });
    const eligible = new Set<string>();
    for (const cat of cats) {
      byCategory.get(cat)!.forEach((f, idx) => {
        if (f.suggestion && f.suggestion.trim().length > 0) {
          eligible.add(findingKey(cat, idx));
        }
      });
    }
    return { orderedCats: cats, groupedByCat: byCategory, eligibleKeys: eligible };
  }, [findings]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PR-V4: visible feedback the apply happened (success) or failed (error).
  // The button click previously only cleared the selection and the parent
  // had no obligation to surface a banner, so users assumed the button was
  // broken. Toast lives next to the apply bar so the cause-effect link is
  // unambiguous; auto-dismiss after 4s mirrors the global Toast variant.
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const interactive = !!pipelineId && eligibleKeys.size > 0;
  const eligibleCount = eligibleKeys.size;

  // Prune stale selections if the findings list changes (e.g. a new
  // Critic pass came in and previously-checked items disappeared).
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (eligibleKeys.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [eligibleKeys]);

  const toggleSelection = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleApplySelected = async () => {
    if (!pipelineId || selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);

    // Collect selected suggestions in the same order they appear on screen
    // so the prompt mirrors what the user sees.
    const orderedSelected: string[] = [];
    for (const cat of orderedCats) {
      const items = groupedByCat.get(cat) ?? [];
      items.forEach((f, idx) => {
        const key = findingKey(cat, idx);
        if (selected.has(key) && f.suggestion && f.suggestion.trim().length > 0) {
          orderedSelected.push(f.suggestion.trim());
        }
      });
    }
    if (orderedSelected.length === 0) {
      setBusy(false);
      return;
    }
    const header = t('chat.criticFindings.feedbackHeader');
    const numbered = orderedSelected.map((s, idx) => `${idx + 1}. ${s}`).join('\n\n');
    let feedback = `${header}\n\n${numbered}`;
    if (feedback.length > FEEDBACK_MAX_CHARS) {
      feedback = feedback.slice(0, FEEDBACK_MAX_CHARS);
    }

    const send = iterateWithFeedback ?? workflowsApi.iterateWithFeedback;
    try {
      await send(pipelineId, feedback);
      setSelected(new Set());
      // PR-V4: visible success acknowledgement. Without this the button
      // looked broken — only the selection cleared, no toast, no banner.
      setToast({
        kind: 'success',
        text: t('chat.criticFindings.applySuccess'),
      });
      onIterationStarted?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : t('chat.criticFindings.applyError');
      setError(message);
      // PR-V4: mirror error to the toast so the failure is just as visible
      // as the success. Inline `applyError` banner stays for backward-compat
      // with the existing test + for richer detail (server-provided message).
      setToast({ kind: 'error', text: t('chat.criticFindings.applyError') });
    } finally {
      setBusy(false);
    }
  };

  // PR-V4: auto-dismiss toast after 4s. Effect-driven so manual state
  // updates (e.g. a second apply mid-window) restart the timer cleanly.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const selectedCountLabel = t('chat.criticFindings.selectedCount')
    .replace('{n}', String(selected.size))
    .replace('{total}', String(eligibleCount));

  return (
    <section className="space-y-2">
      <h4 className="font-semibold text-ak-text-primary">Bulgular</h4>
      {orderedCats.map((cat) => {
        const meta = CATEGORY_META[cat];
        const items = groupedByCat.get(cat)!;
        return (
          <div key={cat} className={`rounded-md border p-2 ${meta.tint}`}>
            <header className="mb-1 flex items-center gap-2 text-xs font-semibold text-ak-text-primary">
              <span aria-hidden="true" className="font-bold">
                {meta.icon}
              </span>
              <span>{meta.label}</span>
              <span className="text-ak-text-tertiary">({items.length})</span>
            </header>
            <ul className="space-y-1.5 pl-5 text-xs">
              {items.map((f, i) => {
                const sev = SEVERITY_META[f.severity];
                const key = findingKey(cat, i);
                const hasSuggestion = !!f.suggestion && f.suggestion.trim().length > 0;
                const isChecked = selected.has(key);
                return (
                  <li key={key} className="space-y-0.5">
                    <div className="flex flex-wrap items-start gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold ${sev.chip}`}
                      >
                        {sev.label}
                      </span>
                      <span className="flex-1 text-ak-text-primary">{f.description}</span>
                    </div>
                    {hasSuggestion && (
                      <div className="flex items-start gap-2 pl-1">
                        {interactive && (
                          <input
                            type="checkbox"
                            data-testid={`critic-finding-checkbox-${key}`}
                            aria-label={t('chat.criticFindings.checkbox.aria')}
                            className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-rose-500 disabled:cursor-not-allowed"
                            checked={isChecked}
                            disabled={busy}
                            onChange={() => toggleSelection(key)}
                          />
                        )}
                        <p className="text-ak-text-tertiary">
                          <span className="text-ak-text-secondary">Öneri:</span> {f.suggestion}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {interactive && (
        <div
          data-testid="critic-findings-apply-bar"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-ak-border-subtle pt-2"
        >
          <span className="text-xs text-ak-text-tertiary">{selectedCountLabel}</span>
          <button
            type="button"
            onClick={handleApplySelected}
            disabled={selected.size === 0 || busy}
            data-testid="critic-findings-apply-button"
            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-200"
          >
            {busy ? t('chat.criticFindings.applying') : t('chat.criticFindings.applySelected')}
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          data-testid="critic-findings-apply-error"
          className="mt-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-200"
        >
          {error}
        </div>
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="critic-apply-toast"
          data-toast-kind={toast.kind}
          className={`mt-2 rounded-md px-3 py-2 text-xs ${
            toast.kind === 'success'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
              : 'bg-rose-500/10 text-rose-700 dark:text-rose-200'
          }`}
        >
          {toast.text}
        </div>
      )}
    </section>
  );
}

export interface ExplanationPanelProps {
  pipelineId: string;
  explanation?: PipelineExplanation;
  defaultExpanded?: boolean;
  className?: string;
  fetcher?: (id: string) => Promise<PipelineExplanation>;
  /**
   * @deprecated PR-B (2026-05-18): the panel no longer renders an inline
   * AttentionBanner — attention points live on the Akış tab of
   * PipelineDetailRail, and duplicating them here was the source of the
   * "Açıklama tab is buried under banners" feedback. Prop kept for API
   * stability so existing callers don't break the build; it is ignored.
   */
  hideAttentionBanner?: boolean;
  /**
   * PR-C: when the panel is shown while the pipeline still has a Critic
   * gate active, the host can wire this callback to refresh state after
   * the user clicks "Seçilenleri uygula" (mirrors `onCriticResolved`).
   */
  onIterationStarted?: () => void;
  /** PR-C: DI for tests — defaults to `workflowsApi.iterateWithFeedback`. */
  iterateWithFeedback?: (id: string, feedback: string) => Promise<unknown>;
  /**
   * PR-D: per-AC binary coverage report. When provided, the Proto reasoning
   * card renders the AC checklist instead of (or alongside) the bullet
   * list. Sourced from `pipeline.intermediateState.acCoverage` by the host.
   */
  acCoverage?: AcCoverageReport;
  /**
   * PR-V6: when provided, the Scribe reasoning card renders disclosures for
   * the full structured spec (problem statement, AC, user stories,
   * out-of-scope) below the standard reasoning bullets. The host typically
   * passes `workflow.stages.scribe.spec` here. Optional so older callers +
   * pipelines without an approved spec keep working untouched.
   */
  scribeSpec?: StructuredSpec | null;
  /**
   * PR-V6: Scribe assumptions surfaced alongside `scribeSpec` through the
   * same disclosure UI.
   */
  scribeAssumptions?: string[] | null;
  /**
   * PR-V6-fix2 (2026-05-20): self-healing fallback fetcher. When
   * `scribeSpec` arrives `undefined` from upstream (e.g. activeWorkflow not
   * yet hydrated, partial SSE state, race on initial mount), the panel
   * fetches the pipeline directly via `pipelineId` and pulls `spec` +
   * `assumptions` out of `stages.scribe`. Without this safety net, the V6
   * disclosures (problem, AC, user stories, out-of-scope, assumptions)
   * silently disappear even though `/api/pipelines/:id` returns them —
   * exactly the bug PR-V6-fix (PR #592) only half-fixed (it handled the
   * `explanation.stages.length === 0` case but not the case where stages
   * exist yet `scribeSpec` is undefined). DI'd via prop so tests can stub
   * the network; defaults to `workflowsApi.get`.
   */
  pipelineFetcher?: (id: string) => Promise<Workflow>;
}

// T5: display-only rename — Critic → Değerlendirme (Evaluator),
// Validator → Statik Kontrol (Static Check). Backend agent identifiers
// (e.g. activity stage 'critic', explainability stageKey 'critic-spec'
// / 'critic-code') stay unchanged; only labels surface the new names.
const AGENT_LABEL: Record<string, string> = {
  scribe: 'Scribe',
  critic: 'Değerlendirme',
  proto: 'Proto',
  trace: 'Trace',
  validator: 'Statik Kontrol',
};

const AGENT_TEXT: Record<string, string> = {
  scribe: 'text-ak-scribe',
  critic: 'text-rose-500 dark:text-rose-300',
  proto: 'text-ak-proto',
  trace: 'text-ak-trace',
  validator: 'text-ak-text-secondary',
};

function formatAgent(name: string, stageKey?: string): string {
  // PR-T3 S6: Critic agent runs twice per pipeline (spec → critic-spec, code →
  // critic-code). Without the suffix the user sees two identical "Critic"
  // cards in the Açıklama tab with no clue which one targets the spec vs
  // the code. Backend already distinguishes via stageKey; surface it.
  if (name === 'critic') {
    if (stageKey === 'critic-spec') return 'Değerlendirme — Spec inceleme';
    if (stageKey === 'critic-code') return 'Değerlendirme — Kod inceleme';
  }
  return AGENT_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

function agentTextClass(name: string): string {
  return AGENT_TEXT[name] ?? 'text-ak-text-primary';
}

interface ReasoningCardProps {
  stage: AgentReasoning;
  expanded: boolean;
  onToggle: () => void;
  /** PR-C: forwarded to the Critic findings selection footer. */
  pipelineId?: string;
  onIterationStarted?: () => void;
  iterateWithFeedback?: (id: string, feedback: string) => Promise<unknown>;
  /**
   * PR-D: when this card is for Proto AND the host supplied an
   * AcCoverageReport, render the per-AC binary checklist between the
   * decision line and the bullet list. Falls through to the legacy
   * bullets when omitted, so existing callers + tests stay green.
   */
  acCoverage?: AcCoverageReport;
  /**
   * PR-V6: rendered inside the Scribe card when supplied. Lets the user
   * expand the full structured spec content (AC, user stories, etc.).
   */
  scribeSpec?: StructuredSpec | null;
  /** PR-V6: assumptions surfaced through the same disclosure UI. */
  scribeAssumptions?: string[] | null;
  /**
   * T4: Critic-Proto iterate loop trajectory threaded through from the
   * `PipelineExplanation` payload. Only rendered on the Critic — Kod
   * inceleme card; other agent cards ignore it.
   */
  iterationTrajectory?: import('../../types/pipeline').IterationTrajectory;
}

function ReasoningCard({
  stage,
  expanded,
  onToggle,
  pipelineId,
  onIterationStarted,
  iterateWithFeedback,
  acCoverage,
  scribeSpec,
  scribeAssumptions,
  iterationTrajectory,
}: ReasoningCardProps) {
  const hasStructuredFindings = !!stage.findings && stage.findings.length > 0;
  const showAcChecklist = stage.agentName === 'proto' && !!acCoverage && acCoverage.totalAcs > 0;
  // T4: trajectory belongs to the Critic — Kod inceleme card (the only one
  // that actually iterates). Spec critic + other agents skip it.
  const showIterationTrajectory =
    stage.agentName === 'critic' &&
    stage.stageKey === 'critic-code' &&
    !!iterationTrajectory &&
    iterationTrajectory.entries.length > 0;
  // PR-V6: only the Scribe card renders the structured-spec disclosures.
  const showScribeOutputs =
    stage.agentName === 'scribe' &&
    (!!scribeSpec || (!!scribeAssumptions && scribeAssumptions.length > 0));
  const hasDetail =
    stage.assumptions.length > 0 ||
    (stage.alternatives && stage.alternatives.length > 0) ||
    (stage.risks && stage.risks.length > 0);
  return (
    <article
      className="rounded-lg border border-ak-border bg-ak-surface p-3"
      data-stage={stage.agentName}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`text-sm font-semibold ${agentTextClass(stage.agentName)}`}>
          {formatAgent(stage.agentName, stage.stageKey)}
        </h3>
        <ConfidenceBadge
          score={stage.confidence.score}
          factors={stage.confidence.factors}
          compact
        />
      </header>
      <p className="mt-1 text-sm text-ak-text-primary">
        <span className="text-ak-text-tertiary">Karar: </span>
        {stage.decision}
      </p>
      {/* When the agent produced structured findings (Critic), render them
          grouped by category so users can parse "neden geçmedi" — instead
          of a flat bullet list. Falls back to bullets for other agents
          and for older runs that lack the findings field. PR-D adds a
          Proto-specific path: when AC coverage is available, render the
          per-AC binary checklist in place of the bullet list. */}
      {hasStructuredFindings ? (
        <div className="mt-2">
          <CriticFindingsSection
            findings={stage.findings!}
            pipelineId={pipelineId}
            onIterationStarted={onIterationStarted}
            iterateWithFeedback={iterateWithFeedback}
          />
        </div>
      ) : showAcChecklist ? (
        <div className="mt-2">
          <AcCoverageChecklist report={acCoverage!} />
        </div>
      ) : (
        stage.reasoning.length > 0 && (
          // PR-U4 M9: compound key from content + index. The bullet lists are
          // append-only in production (a finished stage's output doesn't
          // re-order) but a stable key avoids React diffing surprises when
          // the parent reuses the same stage object across renders with a
          // mutated slice.
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ak-text-secondary">
            {stage.reasoning.map((r, i) => (
              <li key={`${i}-${r.slice(0, 40)}`}>{r}</li>
            ))}
          </ul>
        )
      )}
      {/* PR-V6: surface the full Scribe spec (problem, AC, user stories,
          out-of-scope, assumptions) inside the Scribe stage card. The host
          threads `workflow.stages.scribe.spec` through; for other agents
          this block is dormant. */}
      {showScribeOutputs && (
        <ScribeOutputDisclosures
          spec={scribeSpec}
          assumptions={scribeAssumptions}
          className="mt-2"
        />
      )}
      {/* T4: Critic-Proto iterate loop trajectory — per-iter Proto confidence
          + Critic score + decision, so the user can see "%52 → %67 → %84
          — agent kendi kendine iyileşiyor" instead of just the final
          iteration's score. */}
      {showIterationTrajectory && <IterationTrajectory trajectory={iterationTrajectory} />}
      {hasDetail && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="mt-2 text-xs text-ak-text-tertiary hover:text-ak-text-primary"
        >
          {expanded ? '▾ Detayları gizle' : '▸ Detayları göster'}
        </button>
      )}
      {expanded && hasDetail && (
        <div className="mt-2 space-y-2 border-t border-ak-border-subtle pt-2 text-xs">
          {stage.assumptions.length > 0 && (
            <section>
              <h4 className="font-semibold text-ak-text-primary">Varsayımlar</h4>
              <ul className="list-disc pl-5 text-ak-text-secondary">
                {stage.assumptions.map((a, i) => (
                  <li key={`${i}-${a.slice(0, 40)}`}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {stage.alternatives && stage.alternatives.length > 0 && (
            <section>
              <h4 className="font-semibold text-ak-text-primary">Değerlendirilen alternatifler</h4>
              <ul className="list-disc pl-5 text-ak-text-secondary">
                {stage.alternatives.map((a, i) => (
                  <li key={`${i}-${a.slice(0, 40)}`}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {stage.risks && stage.risks.length > 0 && (
            <section>
              <h4 className="font-semibold text-rose-600 dark:text-rose-300">Riskler</h4>
              <ul className="list-disc pl-5 text-rose-700 dark:text-rose-200/80">
                {stage.risks.map((r, i) => (
                  <li key={`${i}-${r.slice(0, 40)}`}>{r}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * ExplanationPanel — surfaces the full Level-4 narrative for a pipeline.
 */
export function ExplanationPanel({
  pipelineId,
  explanation: priming,
  defaultExpanded = false,
  className,
  fetcher,
  // PR-B sonrası AttentionBanner render'ı tamamen kaldırıldı; bu prop
  // backward-compat için interface'te no-op olarak duruyor.
  hideAttentionBanner: _hideAttentionBanner = false,
  onIterationStarted,
  iterateWithFeedback,
  acCoverage,
  scribeSpec,
  scribeAssumptions,
  pipelineFetcher,
}: ExplanationPanelProps) {
  const [explanation, setExplanation] = useState<PipelineExplanation | null>(priming ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedStages, setExpandedStages] = useState<Set<number>>(() =>
    defaultExpanded ? new Set([0, 1, 2, 3, 4]) : new Set()
  );

  // PR-V6-fix2 (2026-05-20): self-healing scribe-spec fetch. The chain
  // ChatPageLayout → ChatPanel → PipelineDetailRail → ExplanationPanel
  // depends on `activeWorkflow.stages.scribe.spec` being populated on the
  // browser side. Browser inspection on 2026-05-20 (after PR #592 landed)
  // confirmed `/api/pipelines/:id` returns the full spec but the loader
  // doesn't always hydrate it into `activeWorkflow` — race conditions, SSE
  // partial overwrites, smoke-recovered pipelines, etc. Instead of chasing
  // every upstream call site, the panel now owns its own fallback: when
  // `scribeSpec`/`scribeAssumptions` are both empty AND we have a
  // pipelineId, fetch the workflow directly and pull the spec out. Network
  // errors fail silently — the disclosures simply stay hidden (existing
  // behavior, not a regression).
  const [fetchedSpec, setFetchedSpec] = useState<StructuredSpec | null>(null);
  const [fetchedAssumptions, setFetchedAssumptions] = useState<string[] | null>(null);

  const hasIncomingScribeContent =
    !!scribeSpec || (!!scribeAssumptions && scribeAssumptions.length > 0);

  useEffect(() => {
    // Skip the fetch when the host already threaded scribe content through;
    // re-fetching would clobber a fresher upstream value.
    if (hasIncomingScribeContent) return;
    if (!pipelineId) return;
    let cancelled = false;
    const fetchFn = pipelineFetcher ?? workflowsApi.get;
    fetchFn(pipelineId)
      .then((workflow) => {
        if (cancelled) return;
        const spec = workflow?.stages?.scribe?.spec ?? null;
        const assumptions = workflow?.stages?.scribe?.assumptions ?? null;
        setFetchedSpec(spec);
        setFetchedAssumptions(
          Array.isArray(assumptions) && assumptions.length > 0 ? assumptions : null
        );
      })
      .catch(() => {
        // Silent failure — disclosures just don't render. Matches the
        // pre-fix behavior (nothing was rendered when `scribeSpec` was
        // undefined) so no user-visible regression.
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, hasIncomingScribeContent, pipelineFetcher]);

  const effectiveScribeSpec = scribeSpec ?? fetchedSpec;
  const effectiveScribeAssumptions = scribeAssumptions ?? fetchedAssumptions;

  useEffect(() => {
    if (priming) {
      setExplanation(priming);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetch = fetcher ?? workflowsApi.getExplanation;
    fetch(pipelineId)
      .then((data) => {
        if (!cancelled) setExplanation(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Açıklama yüklenemedi');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, priming, fetcher]);

  if (loading && !explanation) {
    return (
      <div role="status" className="text-sm text-ak-text-secondary">
        Açıklama yükleniyor…
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-200"
      >
        {error}
      </div>
    );
  }
  if (!explanation) {
    return null;
  }

  // PR-V6-fix (2026-05-20): when reasoning persistence hasn't produced any
  // stages yet (older pipelines, transient pre-persistence window, smoke
  // re-assignments), we previously early-returned a placeholder and the Scribe
  // spec disclosures (problem statement, AC, user stories, out-of-scope,
  // assumptions) silently disappeared even though `workflow.stages.scribe.spec`
  // was fully populated. The original V6 chain (ChatPageLayout → ChatPanel →
  // PipelineDetailRail → ExplanationPanel → ScribeOutputDisclosures) only
  // covered the happy path where at least one reasoning row exists. Smoke
  // verification on 2026-05-19 confirmed the regression: DOM had 0 `<details>`
  // elements even though `/api/pipelines/:id` returned the spec.
  //
  // Fix: always render the spec disclosures at the top when `scribeSpec`
  // carries content, regardless of `explanation.stages.length`. The
  // empty/legacy placeholders move below the disclosures so the user still
  // gets a clear "no reasoning" signal but the rich spec content is no longer
  // gated behind the persistence layer.
  //
  // PR-V6-fix2 (2026-05-20): use the effective values so the
  // self-healing fetch above benefits every fallback path (empty stages,
  // partial persistence missing the Scribe row, and the per-stage
  // ReasoningCard render below).
  const hasScribeContent =
    !!effectiveScribeSpec ||
    (!!effectiveScribeAssumptions && effectiveScribeAssumptions.length > 0);

  if (explanation.stages.length === 0) {
    // F-11 backfill: pipeline finished before persistence existed → no rows in
    // pipeline_reasonings. Show a distinct, honest message instead of the
    // generic "henüz açıklama yok" so users don't think the agents broke.
    const placeholder = explanation.meta?.persistencePreEpoch ? (
      <div
        role="status"
        className="rounded-lg border border-dashed border-amber-400/40 bg-amber-500/5 px-4 py-6 text-center"
      >
        <p className="text-sm font-medium text-amber-700 dark:text-amber-200">
          Bu pipeline eski sürümde tamamlandı, açıklama kaydı yok.
        </p>
        <p className="mt-1 text-xs text-ak-text-tertiary">
          İsterseniz yeniden çalıştırabilirsiniz.
        </p>
      </div>
    ) : (
      <div className="rounded-lg border border-dashed border-ak-border bg-ak-surface-2 px-4 py-6 text-center">
        <p className="text-sm font-medium text-ak-text-secondary">Henüz açıklama yok</p>
        <p className="mt-1 text-xs text-ak-text-tertiary">
          Pipeline ilerledikçe her ajanın kararı, güven skoru ve riskleri burada görünecek.
        </p>
      </div>
    );

    if (!hasScribeContent) {
      return placeholder;
    }

    return (
      <section
        aria-label="Pipeline açıklaması"
        className={`flex flex-col gap-3 ${className ?? ''}`}
      >
        <article
          className="rounded-lg border border-ak-border bg-ak-surface p-3"
          data-stage="scribe"
          data-testid="scribe-spec-fallback-card"
        >
          <h3 className="text-sm font-semibold text-ak-scribe">Scribe</h3>
          <p className="mt-1 text-xs text-ak-text-tertiary">
            Bu pipeline için ayrıntılı karar kaydı yok; ancak Scribe çıktısı aşağıda görünür.
          </p>
          <ScribeOutputDisclosures
            spec={effectiveScribeSpec}
            assumptions={effectiveScribeAssumptions}
            className="mt-2"
          />
        </article>
        {placeholder}
      </section>
    );
  }

  const toggle = (idx: number) =>
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  // PR-V6-fix (2026-05-20): if stages exist but none is the Scribe stage
  // (e.g., partial persistence ran for Proto/Trace but the Scribe reasoning
  // row was dropped), the ReasoningCard `showScribeOutputs` gate would never
  // fire and the disclosures would not render. Surface a thin "Scribe çıktısı"
  // card at the top so the spec is still inspectable even when its reasoning
  // row never made it to `pipeline_reasonings`.
  const explanationHasScribeStage = explanation.stages.some((s) => s.agentName === 'scribe');
  const showScribeFallback = !explanationHasScribeStage && hasScribeContent;

  return (
    <section aria-label="Pipeline açıklaması" className={`flex flex-col gap-3 ${className ?? ''}`}>
      <div className="flex flex-col gap-2">
        {showScribeFallback && (
          <article
            className="rounded-lg border border-ak-border bg-ak-surface p-3"
            data-stage="scribe"
            data-testid="scribe-spec-fallback-card"
          >
            <h3 className="text-sm font-semibold text-ak-scribe">Scribe</h3>
            <p className="mt-1 text-xs text-ak-text-tertiary">
              Bu pipeline için Scribe kararı kaydedilmemiş; ancak spec çıktısı aşağıda görünür.
            </p>
            <ScribeOutputDisclosures
              spec={effectiveScribeSpec}
              assumptions={effectiveScribeAssumptions}
              className="mt-2"
            />
          </article>
        )}
        {explanation.stages.map((s, idx) => (
          <ReasoningCard
            key={`${s.agentName}-${idx}`}
            stage={s}
            expanded={expandedStages.has(idx)}
            onToggle={() => toggle(idx)}
            pipelineId={pipelineId}
            onIterationStarted={onIterationStarted}
            iterateWithFeedback={iterateWithFeedback}
            acCoverage={acCoverage}
            scribeSpec={effectiveScribeSpec}
            scribeAssumptions={effectiveScribeAssumptions}
            iterationTrajectory={explanation.iterationTrajectory}
          />
        ))}
      </div>
      {explanation.overallNarrative && (
        <footer className="rounded-lg border border-ak-border-subtle bg-ak-surface-2 p-3 text-xs text-ak-text-secondary">
          <h4 className="mb-1 font-semibold text-ak-text-primary">Genel özet</h4>
          <p>{explanation.overallNarrative}</p>
        </footer>
      )}
    </section>
  );
}

export default ExplanationPanel;
