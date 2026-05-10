import { useEffect, useState } from 'react';
import type { PipelineExplanation, AgentReasoning, ReasoningFinding } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import { ConfidenceBadge } from './ConfidenceBadge';
import { AttentionBanner } from './AttentionBanner';

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

function CriticFindingsSection({ findings }: { findings: ReasoningFinding[] }) {
  // Group by category, then sort each group by severity (worst first).
  const byCategory = new Map<ReasoningFinding['category'], ReasoningFinding[]>();
  for (const f of findings) {
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category)!.push(f);
  }
  const orderedCats = Array.from(byCategory.keys()).sort((a, b) => {
    const aMin = Math.min(...byCategory.get(a)!.map((f) => SEVERITY_RANK[f.severity]));
    const bMin = Math.min(...byCategory.get(b)!.map((f) => SEVERITY_RANK[f.severity]));
    return aMin - bMin || a.localeCompare(b);
  });
  return (
    <section className="space-y-2">
      <h4 className="font-semibold text-ak-text-primary">Bulgular</h4>
      {orderedCats.map((cat) => {
        const meta = CATEGORY_META[cat];
        const items = byCategory
          .get(cat)!
          .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
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
                return (
                  <li key={i} className="space-y-0.5">
                    <div className="flex flex-wrap items-start gap-2">
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold ${sev.chip}`}
                      >
                        {sev.label}
                      </span>
                      <span className="flex-1 text-ak-text-primary">{f.description}</span>
                    </div>
                    {f.suggestion && (
                      <p className="pl-1 text-ak-text-tertiary">
                        <span className="text-ak-text-secondary">Öneri:</span> {f.suggestion}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
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
   * Skip the inline AttentionBanner — use when the host (e.g.
   * PipelineDetailRail) already renders attention points itself, so we
   * don't end up showing the same banner twice. Defaults to false so
   * standalone usage keeps the banner.
   */
  hideAttentionBanner?: boolean;
}

const AGENT_LABEL: Record<string, string> = {
  scribe: 'Scribe',
  critic: 'Critic',
  proto: 'Proto',
  trace: 'Trace',
  validator: 'Validator',
};

const AGENT_TEXT: Record<string, string> = {
  scribe: 'text-ak-scribe',
  critic: 'text-rose-500 dark:text-rose-300',
  proto: 'text-ak-proto',
  trace: 'text-ak-trace',
  validator: 'text-ak-text-secondary',
};

function formatAgent(name: string): string {
  return AGENT_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

function agentTextClass(name: string): string {
  return AGENT_TEXT[name] ?? 'text-ak-text-primary';
}

interface ReasoningCardProps {
  stage: AgentReasoning;
  expanded: boolean;
  onToggle: () => void;
}

function ReasoningCard({ stage, expanded, onToggle }: ReasoningCardProps) {
  const hasStructuredFindings = !!stage.findings && stage.findings.length > 0;
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
          {formatAgent(stage.agentName)}
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
          and for older runs that lack the findings field. */}
      {hasStructuredFindings ? (
        <div className="mt-2">
          <CriticFindingsSection findings={stage.findings!} />
        </div>
      ) : (
        stage.reasoning.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ak-text-secondary">
            {stage.reasoning.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )
      )}
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
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {stage.alternatives && stage.alternatives.length > 0 && (
            <section>
              <h4 className="font-semibold text-ak-text-primary">Değerlendirilen alternatifler</h4>
              <ul className="list-disc pl-5 text-ak-text-secondary">
                {stage.alternatives.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {stage.risks && stage.risks.length > 0 && (
            <section>
              <h4 className="font-semibold text-rose-600 dark:text-rose-300">Riskler</h4>
              <ul className="list-disc pl-5 text-rose-700 dark:text-rose-200/80">
                {stage.risks.map((r, i) => (
                  <li key={i}>{r}</li>
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
  hideAttentionBanner = false,
}: ExplanationPanelProps) {
  const [explanation, setExplanation] = useState<PipelineExplanation | null>(priming ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedStages, setExpandedStages] = useState<Set<number>>(() =>
    defaultExpanded ? new Set([0, 1, 2, 3, 4]) : new Set()
  );

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
  if (explanation.stages.length === 0) {
    // F-11 backfill: pipeline finished before persistence existed → no rows in
    // pipeline_reasonings. Show a distinct, honest message instead of the
    // generic "henüz açıklama yok" so users don't think the agents broke.
    if (explanation.meta?.persistencePreEpoch) {
      return (
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
      );
    }
    return (
      <div className="rounded-lg border border-dashed border-ak-border bg-ak-surface-2 px-4 py-6 text-center">
        <p className="text-sm font-medium text-ak-text-secondary">Henüz açıklama yok</p>
        <p className="mt-1 text-xs text-ak-text-tertiary">
          Pipeline ilerledikçe her ajanın kararı, güven skoru ve riskleri burada görünecek.
        </p>
      </div>
    );
  }

  const toggle = (idx: number) =>
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  return (
    <section aria-label="Pipeline açıklaması" className={`flex flex-col gap-3 ${className ?? ''}`}>
      {!hideAttentionBanner && explanation.attentionPoints.length > 0 && (
        <AttentionBanner points={explanation.attentionPoints} />
      )}
      <div className="flex flex-col gap-2">
        {explanation.stages.map((s, idx) => (
          <ReasoningCard
            key={`${s.agentName}-${idx}`}
            stage={s}
            expanded={expandedStages.has(idx)}
            onToggle={() => toggle(idx)}
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
