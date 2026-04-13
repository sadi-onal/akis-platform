import { useState, useCallback } from 'react';
import { cn } from '../../utils/cn';
import { LOGO_MARK_SVG } from '../../theme/brand';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../i18n/useI18n';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { WelcomeWizard } from '../onboarding/WelcomeWizard';
import { AgentFeatureCard } from '../onboarding/AgentFeatureCard';

interface EmptyStateProps {
  variant: 'no-conversation' | 'new-conversation';
  onNewConversation?: () => void;
}

const ScribeIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
  </svg>
);

const ProtoIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
  </svg>
);

const TraceIcon = () => (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
  </svg>
);

export function EmptyState({ variant, onNewConversation }: EmptyStateProps) {
  const { user } = useAuth();
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [showWizard, setShowWizard] = useState(() => {
    // Check both server flag and localStorage for reliability across re-mounts
    if (user?.hasSeenBetaWelcome) return false;
    if (typeof window !== 'undefined' && localStorage.getItem('hasSeenBetaWelcome') === 'true') return false;
    return true;
  });

  const handleWizardComplete = useCallback(async () => {
    try {
      localStorage.setItem('hasSeenBetaWelcome', 'true');
      await fetch('/auth/update-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hasSeenBetaWelcome: true }),
      });
    } catch { /* best-effort */ }
    setShowWizard(false);
  }, []);

  // New conversation variant — simple prompt
  if (variant === 'new-conversation') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4">
        <img src={LOGO_MARK_SVG} alt="AKIS" className="h-16 w-16 object-contain opacity-60" loading="eager" />
        <div className="max-w-md text-center">
          <h3 className="text-lg font-semibold text-ak-text-primary">
            {t('chat.emptyState.greeting')} <span className="text-ak-primary">{t('chat.emptyState.brandName')}</span>.
          </h3>
          <p className="mt-1.5 text-sm text-ak-text-tertiary leading-relaxed">
            {t('chat.emptyState.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-ak-text-tertiary">
          <span className="rounded-full bg-ak-scribe/10 px-2 py-0.5 text-ak-scribe">Scribe</span>
          <span>→</span>
          <span className="rounded-full bg-ak-proto/10 px-2 py-0.5 text-ak-proto">Proto</span>
          <span>→</span>
          <span className="rounded-full bg-ak-trace/10 px-2 py-0.5 text-ak-trace">Trace</span>
        </div>
      </div>
    );
  }

  // Hero variant — animated empty state with feature cards
  return (
    <>
      {showWizard && <WelcomeWizard onComplete={handleWizardComplete} />}

      <div className="relative flex flex-1 flex-col items-center justify-center gap-6 px-4 overflow-hidden">
        {/* Background blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className={cn(
            'absolute -top-32 -right-32 h-64 w-64 rounded-full bg-ak-primary/5 blur-blob',
            !reduced && 'animate-blob-drift',
          )} />
          <div className={cn(
            'absolute -bottom-32 -left-32 h-72 w-72 rounded-full bg-ak-primary/3 blur-blob',
            !reduced && 'animate-blob-drift-alt',
          )} />
        </div>

        {/* Hero content */}
        <div className="relative z-10 flex flex-col items-center gap-6 w-full max-w-xl">
          <img
            src={LOGO_MARK_SVG}
            alt="AKIS"
            className={cn('h-20 w-20 object-contain', !reduced && 'animate-float-gentle')}
            loading="eager"
          />

          <div className="text-center">
            <h2 className={cn('text-2xl font-bold text-ak-text-primary', !reduced && 'animate-fade-in')}>
              {t('chat.emptyState.greeting')} <span className="text-ak-primary">{t('chat.emptyState.brandName')}</span>.
            </h2>
            <p className={cn(
              'mt-2 text-sm text-ak-text-tertiary leading-relaxed max-w-md mx-auto',
              !reduced && 'animate-fade-in',
            )} style={!reduced ? { animationDelay: '100ms', animationFillMode: 'backwards' } : undefined}>
              {t('chat.emptyState.heroSubtitle')}
            </p>
          </div>

          {/* Agent feature cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full mt-2">
            <AgentFeatureCard
              agent="scribe"
              title="Scribe"
              description={t('chat.emptyState.scribeDesc')}
              icon={<ScribeIcon />}
              delay={reduced ? 0 : 200}
            />
            <AgentFeatureCard
              agent="proto"
              title="Proto"
              description={t('chat.emptyState.protoDesc')}
              icon={<ProtoIcon />}
              delay={reduced ? 0 : 400}
            />
            <AgentFeatureCard
              agent="trace"
              title="Trace"
              description={t('chat.emptyState.traceDesc')}
              icon={<TraceIcon />}
              delay={reduced ? 0 : 600}
            />
          </div>

          {/* CTA */}
          {onNewConversation && (
            <button
              onClick={onNewConversation}
              className={cn(
                'mt-2 rounded-xl bg-ak-primary px-8 py-3 text-sm font-semibold text-[color:var(--ak-on-primary,#fff)]',
                'shadow-ak-glow hover:brightness-110 active:brightness-95 transition-all duration-150',
                !reduced && 'animate-slide-up',
              )}
              style={!reduced ? { animationDelay: '700ms', animationFillMode: 'backwards' } : undefined}
            >
              {t('chat.emptyState.newChat')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
