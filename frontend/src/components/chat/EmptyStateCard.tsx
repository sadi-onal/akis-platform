/**
 * EmptyStateCard — onboarding card shown on /chat when the user has zero
 * conversations (B3). Replaces the legacy 3-agent hero for first-time
 * visitors so they have a concrete "click here to start" path instead of
 * a blank composer.
 *
 * Two interactions:
 *   - Demo button → fires `onDemoSelect(idea)` with the full idea text. The
 *     parent (ChatPage) translates that into a brand-new pipeline create.
 *   - "Kendi fikrini yaz" → fires `onManualStart()`. Parent sets the pending
 *     conversation so the composer focuses empty.
 *
 * Icons are inline SVG (no lucide-react in deps) to match the rest of the
 * chat components.
 */
import type { ReactNode } from 'react';

import { useI18n } from '../../i18n/useI18n';
import { LOGO_MARK_SVG } from '../../theme/brand';
import { cn } from '../../utils/cn';

import { DEMO_PROJECTS, type DemoProject, type DemoProjectIconName } from './demoProjects';

interface EmptyStateCardProps {
  onDemoSelect: (idea: string) => void;
  onManualStart: () => void;
}

const TodoIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75l2.25 2.25L15 11.25M4.5 6.75A2.25 2.25 0 016.75 4.5h10.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25H6.75a2.25 2.25 0 01-2.25-2.25V6.75z" />
  </svg>
);

const CurrencyIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m4-9a3 3 0 00-3-3h-2a3 3 0 000 6h2a3 3 0 010 6h-2a3 3 0 01-3-3" />
  </svg>
);

const QrIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875A1.125 1.125 0 014.875 3.75h4.5A1.125 1.125 0 0110.5 4.875v4.5A1.125 1.125 0 019.375 10.5h-4.5A1.125 1.125 0 013.75 9.375v-4.5zm0 9.75A1.125 1.125 0 014.875 13.5h4.5A1.125 1.125 0 0110.5 14.625v4.5A1.125 1.125 0 019.375 20.25h-4.5A1.125 1.125 0 013.75 19.125v-4.5zm9.75-9.75A1.125 1.125 0 0114.625 3.75h4.5A1.125 1.125 0 0120.25 4.875v4.5A1.125 1.125 0 0119.125 10.5h-4.5A1.125 1.125 0 0113.5 9.375v-4.5zM13.5 14.25h2.25v2.25H13.5v-2.25zm0 4.5h2.25V21H13.5v-2.25zm4.5-4.5H21v2.25H18v-2.25zm0 4.5H21V21H18v-2.25z" />
  </svg>
);

const MarkdownIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zM8.25 13.5l1.5 1.5 3-3m1.5 0v6" />
  </svg>
);

const ICONS: Record<DemoProjectIconName, () => ReactNode> = {
  todo: TodoIcon,
  currency: CurrencyIcon,
  qr: QrIcon,
  markdown: MarkdownIcon,
};

function DemoButton({
  demo,
  label,
  onClick,
}: {
  demo: DemoProject;
  label: string;
  onClick: () => void;
}) {
  const Icon = ICONS[demo.icon];
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`empty-state-demo-${demo.id}`}
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-ak-border bg-ak-surface p-3 text-left transition-all',
        'hover:border-ak-primary/40 hover:bg-ak-surface-2 hover:shadow-sm',
        'focus:outline-none focus:ring-2 focus:ring-ak-primary/40',
        'active:scale-[0.99]',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ak-primary/10 text-ak-primary',
          'group-hover:bg-ak-primary/15',
        )}
        aria-hidden
      >
        <Icon />
      </span>
      <span className="text-sm font-medium text-ak-text-primary">{label}</span>
    </button>
  );
}

export function EmptyStateCard({ onDemoSelect, onManualStart }: EmptyStateCardProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-1 flex-col items-center px-4 pt-10 sm:pt-14">
      <div className="w-full max-w-md sm:max-w-lg">
        <div className="flex flex-col items-center gap-4 text-center">
          <img src={LOGO_MARK_SVG} alt="AKIS" className="h-14 w-14 object-contain" loading="eager" />
          <div>
            <h2 className="text-xl font-semibold text-ak-text-primary sm:text-2xl">
              {t('chat.empty.title')}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ak-text-tertiary">
              {t('chat.empty.description')}
            </p>
          </div>
        </div>

        <div
          role="group"
          aria-label={t('chat.empty.title')}
          className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {DEMO_PROJECTS.map((demo) => (
            <DemoButton
              key={demo.id}
              demo={demo}
              label={t(demo.labelKey)}
              onClick={() => onDemoSelect(t(demo.ideaKey))}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={onManualStart}
          data-testid="empty-state-manual-start"
          className={cn(
            'mt-4 w-full rounded-xl border border-dashed border-ak-border bg-transparent px-4 py-2.5',
            'text-sm font-medium text-ak-text-secondary transition-colors',
            'hover:border-ak-primary/40 hover:text-ak-text-primary',
            'focus:outline-none focus:ring-2 focus:ring-ak-primary/40',
          )}
        >
          {t('chat.empty.manualStart')}
        </button>
      </div>
    </div>
  );
}
