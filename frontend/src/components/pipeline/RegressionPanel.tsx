import { useEffect, useState } from 'react';
import type { RegressionReport, RegressionStatus } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';

// Per-status surface metadata. Mirrors the colour/severity discipline of
// ExplanationPanel's CriticFindingsSection — light + dark + ak-* tokens
// only, no inline colour values.
const STATUS_META: Record<RegressionStatus, { label: string; pill: string }> = {
  verified_baseline: {
    label: 'Doğrulanmış',
    pill: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  },
  self_healed: {
    label: 'Kendini düzeltti',
    pill: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30',
  },
  degraded: {
    label: 'Eksik kapsam',
    pill: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  },
  no_baseline: {
    label: 'Test taban çizgisi yok',
    pill: 'bg-slate-500/10 text-slate-700 border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-200 dark:border-slate-500/30',
  },
};

const ITERATION_REQUEST_TRUNCATE = 80;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function fixLoopSuffix(triggered: boolean, succeeded: boolean): { value: string; suffix: string } {
  if (!triggered) return { value: '0 kez', suffix: 'tetiklenmedi' };
  if (succeeded) return { value: ' ', suffix: 'düzeldi' };
  return { value: ' ', suffix: 'başarısız' };
}

export interface RegressionPanelProps {
  pipelineId: string;
  /** When provided, the panel renders directly without fetching. */
  report?: RegressionReport;
  /** DI for tests — falls back to workflowsApi.getRegression. */
  fetcher?: (id: string) => Promise<RegressionReport>;
  className?: string;
}

/**
 * RegressionPanel — Tier 1.A. Surfaces the bakkal-readable confidence
 * answer ("Bu değişiklik N dosyaya dokundu. Baseline T testle %P
 * kapsam. AKIS K kez kendini düzeltti.") for completed pipelines and
 * iteration children.
 */
export function RegressionPanel({
  pipelineId,
  report: priming,
  fetcher,
  className,
}: RegressionPanelProps) {
  const [report, setReport] = useState<RegressionReport | null>(priming ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (priming) {
      setReport(priming);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetch = fetcher ?? workflowsApi.getRegression;
    fetch(pipelineId)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Regresyon raporu yüklenemedi');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, priming, fetcher]);

  if (loading && !report) {
    return (
      <div role="status" className="text-sm text-ak-text-secondary">
        Regresyon raporu yükleniyor…
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
  if (!report) return null;

  const meta = STATUS_META[report.status];
  const filesChangedDisplay =
    typeof report.iterationFilesChanged === 'number' ? String(report.iterationFilesChanged) : '—';
  const baseline = report.baseline;
  const coveredAC = baseline?.coveredCriteria.length ?? 0;
  const totalAC = coveredAC + (baseline?.uncoveredCriteria.length ?? 0);
  const fix = fixLoopSuffix(report.fixLoop.triggered, report.fixLoop.succeeded);

  return (
    <section
      aria-label="Regresyon güven yüzeyi"
      className={`flex flex-col gap-3 ${className ?? ''}`}
      data-status={report.status}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${meta.pill}`}
          data-testid="regression-status-pill"
        >
          {meta.label}
        </span>
        <h3 className="text-sm font-semibold text-ak-text-primary">{report.headline}</h3>
      </header>

      {report.iterationRequest && (
        <div
          className="inline-flex max-w-fit items-center gap-1 rounded-md border border-ak-border-subtle bg-ak-surface-2 px-2 py-1 text-xs text-ak-text-secondary"
          title={report.iterationRequest}
        >
          <span className="font-medium text-ak-text-tertiary">İterasyon:</span>
          <span>{truncate(report.iterationRequest, ITERATION_REQUEST_TRUNCATE)}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="regression-tiles">
        <Tile label="Değişen dosya" value={filesChangedDisplay} subtitle="bu iterasyonda" />
        <Tile
          label="Baseline test"
          value={baseline ? `${coveredAC}/${totalAC} kriter` : '—'}
          subtitle={
            baseline
              ? `${baseline.totalTests} test, %${baseline.coveragePercentage} kapsam`
              : 'baseline yok'
          }
        />
        <Tile
          label="FixLoop"
          value={report.fixLoop.triggered ? `${report.fixLoop.runs} kez` : fix.value}
          subtitle={fix.suffix}
        />
      </div>

      <footer className="rounded-lg border border-ak-border-subtle bg-ak-surface-2 p-3 text-xs text-ak-text-secondary">
        <p>{report.bakkalSummary}</p>
      </footer>
    </section>
  );
}

interface TileProps {
  label: string;
  value: string;
  subtitle: string;
}

function Tile({ label, value, subtitle }: TileProps) {
  return (
    <article
      className="rounded-lg border border-ak-border bg-ak-surface p-3"
      data-testid="regression-tile"
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-ak-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-ak-text-secondary">{subtitle}</p>
    </article>
  );
}

export default RegressionPanel;
