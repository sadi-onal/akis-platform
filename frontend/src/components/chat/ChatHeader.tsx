import { cn } from '../../utils/cn';
import { useI18n } from '../../i18n/useI18n';
import type { ChatMode } from '../../types/chat';
import type { WorkflowTokenUsage } from '../../types/workflow';
import { TokenGauge } from './TokenGauge';

const MODE_STYLES: Record<ChatMode, string> = {
  ask: 'bg-blue-500/15 text-blue-400',
  plan: 'bg-orange-500/15 text-orange-400',
  act: 'bg-emerald-500/15 text-emerald-400',
  review: 'bg-yellow-500/15 text-yellow-400',
};

// Bakkal-language one-liners — see docs/product/02-ux.md § 6 + 05-findings F-05.
// Tooltip text is intentionally jargon-free (no "Scribe / Proto / Trace / spec");
// strings live in `frontend/src/i18n/locales/{tr,en}.json` under `chat.modeBadge.*`.
const MODE_TOOLTIP_KEYS: Record<ChatMode, 'chat.modeBadge.ask' | 'chat.modeBadge.plan' | 'chat.modeBadge.act' | 'chat.modeBadge.review'> = {
  ask: 'chat.modeBadge.ask',
  plan: 'chat.modeBadge.plan',
  act: 'chat.modeBadge.act',
  review: 'chat.modeBadge.review',
};

interface ChatHeaderProps {
  repoShortName: string;
  repoFullName: string;
  repoUrl?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  mode?: ChatMode;
  /** When true, overrides the mode chip with a red "HATA" badge. */
  isFailed?: boolean;
  hasPreview?: boolean;
  showPreview?: boolean;
  onTogglePreview?: () => void;
  onBack?: () => void;
  showBackButton?: boolean;
  tokenUsage?: WorkflowTokenUsage;
}

export function ChatHeader({
  repoShortName,
  repoFullName,
  repoUrl,
  branch,
  prUrl,
  prNumber,
  mode,
  isFailed,
  hasPreview,
  showPreview,
  onTogglePreview,
  onBack,
  showBackButton,
  tokenUsage,
}: ChatHeaderProps) {
  const { t } = useI18n();
  const modeTooltip = mode ? t(MODE_TOOLTIP_KEYS[mode]) : '';
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-ak-border bg-ak-surface px-4 py-3 z-10">
      {showBackButton && (
        <button
          onClick={onBack}
          aria-label="Geri"
          className="rounded-lg p-1.5 text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary transition-colors"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Mode badge — overridden by HATA when pipeline has failed.
          F-05: each mode carries a bakkal-language tooltip + aria-label so the
          rozet is meaningful (NFR-5.3: "ya net açıklamalı ya yok"). */}
      {isFailed ? (
        <span
          role="status"
          data-testid="chat-mode-badge"
          className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-red-500/15 text-red-400"
          title={t('chat.modeBadge.failed.title')}
          aria-label={t('chat.modeBadge.failed.aria')}
        >
          HATA
        </span>
      ) : mode ? (
        <span
          role="status"
          data-testid="chat-mode-badge"
          className={cn(
            'rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
            MODE_STYLES[mode]
          )}
          title={modeTooltip}
          aria-label={modeTooltip}
        >
          {mode}
        </span>
      ) : null}

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-ak-text-primary" title={repoShortName}>
          {repoShortName}
        </h1>
        {repoFullName && (
          <p className="truncate text-[11px] text-ak-text-tertiary">
            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-ak-primary transition-colors"
              >
                {repoFullName}
              </a>
            ) : (
              repoFullName
            )}
          </p>
        )}
      </div>

      {/* Repo badge */}
      {repoFullName && repoUrl && (
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'hidden items-center gap-1 rounded-lg border border-ak-border px-2 py-0.5 text-[11px] text-ak-text-secondary sm:flex',
            'hover:border-ak-primary hover:text-ak-primary transition-colors'
          )}
        >
          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
            <path
              fillRule="evenodd"
              d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"
            />
          </svg>
          {repoFullName.split('/').pop()}
        </a>
      )}

      {/* Branch badge */}
      {branch && (
        <div className="hidden items-center gap-1.5 sm:flex">
          <svg className="h-3 w-3 text-green-400" fill="currentColor" viewBox="0 0 16 16">
            <path
              fillRule="evenodd"
              d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.493 2.493 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"
            />
          </svg>
          <span className="rounded bg-ak-surface-2 px-2 py-0.5 font-mono text-[11px] text-ak-text-secondary">
            {branch}
          </span>
        </div>
      )}

      {/* Preview toggle */}
      {hasPreview && (
        <button
          onClick={onTogglePreview}
          aria-label={showPreview ? 'Preview kapat' : 'Preview aç'}
          className={cn(
            'hidden items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium md:flex transition-colors',
            showPreview
              ? 'border-ak-primary bg-ak-primary/10 text-ak-primary'
              : 'border-ak-border text-ak-text-secondary hover:border-ak-primary hover:text-ak-primary'
          )}
        >
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Preview
        </button>
      )}

      {/* Token gauge (issue #438) */}
      {tokenUsage && tokenUsage.totalTokens > 0 && <TokenGauge usage={tokenUsage} />}

      {/* PR badge */}
      {prUrl && prNumber && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'hidden items-center gap-1 rounded-lg border border-ak-border px-2.5 py-1 text-[11px] text-ak-text-secondary sm:flex',
            'hover:border-ak-primary hover:text-ak-primary transition-colors'
          )}
        >
          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
            <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          PR #{prNumber}
        </a>
      )}
    </div>
  );
}
