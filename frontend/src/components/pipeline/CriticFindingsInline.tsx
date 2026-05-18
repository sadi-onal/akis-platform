import type { CriticReviewOutput, ReasoningFinding } from '../../types/pipeline';
import { CriticFindingsSection } from './ExplanationPanel';
import { useI18n } from '../../i18n/useI18n';

export interface CriticFindingsInlineProps {
  pipelineId: string;
  /**
   * PR-F (2026-05-19): Critic guardrail mode'da bulgular Proto kartının
   * altında inline gösterilir. `criticReview.findings` array'i boş veya
   * undefined ise hiçbir şey render edilmez.
   */
  criticReview: CriticReviewOutput | undefined;
  /** Invoked after a successful iterate-with-feedback so the parent refreshes. */
  onIterationStarted?: () => void;
  /** DI for tests — defaults to workflowsApi.iterateWithFeedback. */
  iterateWithFeedback?: (id: string, feedback: string) => Promise<unknown>;
  className?: string;
}

const SEVERITY_LABEL: Record<'critical' | 'major' | 'minor' | 'info', string> = {
  critical: 'Kritik',
  major: 'Önemli',
  minor: 'Küçük',
  info: 'Bilgi',
};

/**
 * PR-F (mimari refactor 2026-05-19) — CriticFindingsInline.
 *
 * Critic ana akıştan çıkarıldığında bulguların hiçbir yerde kaybolmaması
 * için Proto stage kartının altında inline render edilir. Bileşen:
 *
 *   1. Bir özet rozeti (en yüksek severity + bulgu sayısı)
 *   2. Mevcut `CriticFindingsSection` üzerinden checkbox + "Uygula" akışı
 *      (ExplanationPanel'deki PR-C pattern'i ile aynı, kod tekrarı yok)
 *
 * Findings array'i boşsa veya `criticReview` undefined ise null döner.
 * Böylece host (PipelineDetailRail / ChatPanel) koşulsuz mount edebilir.
 */
export function CriticFindingsInline({
  pipelineId,
  criticReview,
  onIterationStarted,
  iterateWithFeedback,
  className,
}: CriticFindingsInlineProps) {
  const { t } = useI18n();
  if (!criticReview) return null;
  const findings = criticReview.findings ?? [];
  if (findings.length === 0) return null;

  // CriticReviewOutput findings -> ReasoningFinding shape.
  // PR-F not: CriticFinding.category `string` (backend artık serbest bir
  // metin de gönderebilir), ReasoningFinding.category daraltılmış bir union.
  // Eşleşmeyen kategorileri "completeness"e düşürerek tip uyumu sağlanıyor.
  const VALID_CATEGORIES: ReasoningFinding['category'][] = [
    'completeness',
    'ambiguity',
    'consistency',
    'testability',
    'spec_compliance',
    'security',
  ];
  const normalizeCategory = (raw: string): ReasoningFinding['category'] =>
    (VALID_CATEGORIES as readonly string[]).includes(raw)
      ? (raw as ReasoningFinding['category'])
      : 'completeness';

  const reasoningFindings: ReasoningFinding[] = findings.map((f) => ({
    severity: f.severity,
    category: normalizeCategory(f.category),
    description: f.description,
    suggestion: f.suggestion,
    location: f.location,
  }));

  // Özet rozeti: max severity (backend `maxSeverity` alanından gelir,
  // yoksa client-side hesaplanır — backward-compat).
  const maxSeverity =
    criticReview.maxSeverity ??
    (findings.reduce<'critical' | 'major' | 'minor' | 'info'>((acc, f) => {
      const order: Record<typeof acc, number> = {
        info: 0,
        minor: 1,
        major: 2,
        critical: 3,
      };
      return order[f.severity] > order[acc] ? f.severity : acc;
    }, 'info'));

  const chipClass =
    maxSeverity === 'critical'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-200'
      : maxSeverity === 'major'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200'
        : 'border-slate-500/30 bg-slate-500/5 text-ak-text-secondary';

  return (
    <section
      data-testid="critic-findings-inline"
      data-max-severity={maxSeverity}
      aria-label={t('chat.critic.resolution.title')}
      className={`rounded-lg border border-ak-border-subtle bg-ak-surface-2/40 p-3 ${
        className ?? ''
      }`}
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ak-text-tertiary">
          Critic incelemesi
        </h4>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chipClass}`}
        >
          {findings.length} bulgu · {SEVERITY_LABEL[maxSeverity]}
        </span>
      </header>
      <CriticFindingsSection
        findings={reasoningFindings}
        pipelineId={pipelineId}
        onIterationStarted={onIterationStarted}
        iterateWithFeedback={iterateWithFeedback}
      />
    </section>
  );
}

export default CriticFindingsInline;
