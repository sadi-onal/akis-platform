import { useEffect, useState } from 'react';
import type { PipelineExplanation, AgentReasoning } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import { ConfidenceBadge } from './ConfidenceBadge';
import { AttentionBanner } from './AttentionBanner';

export interface ExplanationPanelProps {
  pipelineId: string;
  explanation?: PipelineExplanation;
  defaultExpanded?: boolean;
  className?: string;
  fetcher?: (id: string) => Promise<PipelineExplanation>;
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
      {stage.reasoning.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ak-text-secondary">
          {stage.reasoning.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
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
      {explanation.attentionPoints.length > 0 && (
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
