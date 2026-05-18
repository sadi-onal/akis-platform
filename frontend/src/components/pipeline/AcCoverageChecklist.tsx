// PR-D: Per-AC binary checklist — replaces the mechanical Proto-confidence
// percentage in the Explanation panel + cinema Proto card.
//
// Surface contract (UX):
//   • Header summary: "{n}/{total} kriter için kod var" (static layer)
//     and when Trace ran: "{m} için test de var" (dynamic layer).
//   • Per-row icon: green check when covered (static), neutral dash when not.
//     If Trace ran AND dynamicCovered is true, append a small "+test" pill.
//   • Optional file/test path footnote per covered row.

import { useState } from 'react';
import type { AcCoverageReport } from '../../types/pipeline';
import { useI18n } from '../../i18n/useI18n';

interface AcCoverageChecklistProps {
  report: AcCoverageReport;
  /** When true (default), the per-row file/test paths render. */
  showDetails?: boolean;
  className?: string;
}

function CoveredIcon({ covered }: { covered: boolean }) {
  return covered ? (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
    >
      ✓
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ak-border-subtle text-[10px] font-bold text-ak-text-tertiary"
    >
      –
    </span>
  );
}

export function AcCoverageChecklist({
  report,
  showDetails = true,
  className,
}: AcCoverageChecklistProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<boolean>(true);

  if (report.totalAcs === 0) {
    return (
      <section
        data-testid="ac-coverage-empty"
        className={`rounded-md border border-dashed border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-tertiary ${className ?? ''}`}
      >
        {t('pipeline.acCoverage.emptyState')}
      </section>
    );
  }

  const hasTrace = report.dynamicCoveredCount > 0 || report.items.some((i) => i.dynamicCovered);
  const summaryStatic = t('pipeline.acCoverage.summaryStatic')
    .replace('{n}', String(report.staticCoveredCount))
    .replace('{total}', String(report.totalAcs));
  const summaryDynamic = hasTrace
    ? t('pipeline.acCoverage.summaryDynamic').replace('{n}', String(report.dynamicCoveredCount))
    : null;

  return (
    <section
      data-testid="ac-coverage"
      className={`rounded-md border border-ak-border bg-ak-surface p-2 text-xs ${className ?? ''}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-ak-text-primary">
            {t('pipeline.acCoverage.title')}
          </h4>
          <p className="text-ak-text-secondary" data-testid="ac-coverage-summary">
            {summaryStatic}
            {summaryDynamic ? ` · ${summaryDynamic}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="rounded-md border border-ak-border-subtle px-2 py-0.5 text-[11px] text-ak-text-tertiary hover:text-ak-text-primary"
        >
          {expanded ? t('pipeline.acCoverage.hideList') : t('pipeline.acCoverage.showList')}
        </button>
      </header>

      {expanded && (
        <ul className="mt-2 space-y-1.5" data-testid="ac-coverage-items">
          {report.items.map((item) => {
            const status = item.staticCovered
              ? t('pipeline.acCoverage.covered')
              : t('pipeline.acCoverage.notCovered');
            return (
              <li
                key={item.acId}
                data-testid={`ac-coverage-item-${item.acId}`}
                data-covered={item.staticCovered}
                data-dynamic-covered={item.dynamicCovered}
                className="flex items-start gap-2"
              >
                <CoveredIcon covered={item.staticCovered} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-ak-text-primary">
                    <span className="font-mono text-[10px] uppercase text-ak-text-tertiary">
                      {item.acId}
                    </span>
                    <span className="break-words">{item.acDescription}</span>
                    {item.dynamicCovered && (
                      <span
                        data-testid={`ac-coverage-dynamic-badge-${item.acId}`}
                        className="inline-flex items-center rounded-full border border-violet-400/40 bg-violet-500/10 px-1.5 py-0 text-[10px] font-medium text-violet-700 dark:text-violet-200"
                        title={t('pipeline.acCoverage.coveringTests').replace(
                          '{tests}',
                          item.coveringTests.join(', ')
                        )}
                      >
                        +{t('pipeline.acCoverage.testBadge')}
                      </span>
                    )}
                    {!item.staticCovered && (
                      <span className="text-[10px] uppercase tracking-wide text-ak-text-tertiary">
                        ({status})
                      </span>
                    )}
                  </p>
                  {showDetails && item.staticCovered && item.coveringFiles.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-ak-text-tertiary">
                      {t('pipeline.acCoverage.coveringFiles').replace(
                        '{files}',
                        item.coveringFiles.join(', ')
                      )}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default AcCoverageChecklist;
