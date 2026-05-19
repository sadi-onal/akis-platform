import type { StructuredSpec } from '../../types/workflow';

/**
 * PR-V6 — surfaces the full Scribe spec output as native `<details>`
 * disclosures. Used in two places so the rich spec content (acceptance
 * criteria, user stories, problem statement, out-of-scope, assumptions)
 * is no longer invisible after the PlanCard summary:
 *
 *   1. `PlanCard` — chat "Proje planı" message body
 *   2. `ExplanationPanel` — Açıklama tab's Scribe stage card
 *
 * Native `<details>` keeps the component stateless and a11y-friendly.
 * Renders nothing when neither spec nor assumptions carry content, so
 * older pipelines (and chat messages without `spec`) stay visually
 * identical to today.
 */
export interface ScribeOutputDisclosuresProps {
  spec?: StructuredSpec | null;
  assumptions?: string[] | null;
  /**
   * Optional className on the wrapper. Kept narrow on purpose — both
   * call sites just want spacing tweaks above the first disclosure.
   */
  className?: string;
}

const summaryClass =
  'cursor-pointer text-xs font-semibold uppercase tracking-widest text-ak-text-tertiary hover:text-ak-text-primary transition-colors';

const sectionClass = 'mt-3 first:mt-0';

export function ScribeOutputDisclosures({
  spec,
  assumptions,
  className,
}: ScribeOutputDisclosuresProps) {
  const hasAssumptions = !!assumptions && assumptions.length > 0;
  const hasProblem = !!spec?.problemStatement;
  const hasAcs = !!spec?.acceptanceCriteria && spec.acceptanceCriteria.length > 0;
  const hasStories = !!spec?.userStories && spec.userStories.length > 0;
  const hasOutOfScope = !!spec?.outOfScope && spec.outOfScope.length > 0;

  if (!hasAssumptions && !hasProblem && !hasAcs && !hasStories && !hasOutOfScope) {
    return null;
  }

  return (
    <div className={className} data-testid="scribe-output-disclosures">
      {hasProblem ? (
        <details className={sectionClass} data-testid="scribe-problem-statement-disclosure">
          <summary className={summaryClass}>Problem Tanımı</summary>
          <p className="mt-2 pl-4 text-sm leading-relaxed text-ak-text-primary">
            {spec!.problemStatement}
          </p>
        </details>
      ) : null}

      {hasAcs ? (
        <details className={sectionClass} data-testid="scribe-acceptance-criteria-disclosure">
          <summary className={summaryClass}>
            Kabul Kriterleri ({spec!.acceptanceCriteria.length})
          </summary>
          <ol className="mt-2 space-y-2 pl-4">
            {spec!.acceptanceCriteria.map((ac, i) => (
              <li
                key={ac.id ?? `${i}-${(ac.given ?? '').slice(0, 24)}`}
                className="rounded-md border border-ak-border-subtle bg-ak-surface-2/40 p-2 text-sm text-ak-text-primary"
              >
                {ac.id ? (
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ak-text-tertiary">
                    {ac.id}
                  </div>
                ) : null}
                {ac.summary ? (
                  <div className="mt-0.5 font-medium text-ak-text-primary">{ac.summary}</div>
                ) : null}
                <div className="mt-1">
                  <span className="font-medium text-ak-text-secondary">Verildiğinde:</span>{' '}
                  {ac.given}
                </div>
                <div>
                  <span className="font-medium text-ak-text-secondary">Olduğunda:</span> {ac.when}
                </div>
                <div>
                  <span className="font-medium text-ak-text-secondary">Sonuç:</span> {ac.then}
                </div>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {hasStories ? (
        <details className={sectionClass} data-testid="scribe-user-stories-disclosure">
          <summary className={summaryClass}>
            Kullanıcı Hikayeleri ({spec!.userStories.length})
          </summary>
          <ul className="mt-2 space-y-1.5 pl-4">
            {spec!.userStories.map((us, i) => {
              const persona = us.persona ?? us.as ?? 'Kullanıcı';
              const action = us.action ?? us.iWant ?? '';
              const benefit = us.benefit ?? us.soThat ?? '';
              return (
                <li key={`${i}-${persona.slice(0, 16)}`} className="text-sm text-ak-text-primary">
                  <span className="font-medium text-ak-text-secondary">{persona}</span>
                  {action ? <> şunu yapmak istiyor: {action}</> : null}
                  {benefit ? <> — böylece {benefit}</> : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {hasOutOfScope ? (
        <details className={sectionClass} data-testid="scribe-out-of-scope-disclosure">
          <summary className={summaryClass}>Kapsam Dışı ({spec!.outOfScope!.length})</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {spec!.outOfScope!.map((o, i) => (
              <li key={`${i}-${o.slice(0, 24)}`} className="text-sm text-ak-text-primary">
                — {o}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {hasAssumptions ? (
        <details className={sectionClass} data-testid="scribe-assumptions-disclosure">
          <summary className={summaryClass}>Varsayımlar ({assumptions!.length})</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {assumptions!.map((a, i) => (
              <li key={`${i}-${a.slice(0, 24)}`} className="text-sm text-ak-text-primary">
                — {a}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default ScribeOutputDisclosures;
