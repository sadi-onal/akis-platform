import { useState, useCallback } from 'react';
import { cn } from '../../utils/cn';
import { LOGO_MARK_SVG } from '../../theme/brand';
import { AgentFeatureCard } from './AgentFeatureCard';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface WelcomeWizardProps {
  onComplete: () => void;
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

export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const [step, setStep] = useState(0);
  const [exiting, setExiting] = useState(false);
  const reduced = useReducedMotion();

  const handleNext = useCallback(() => {
    if (step < 2) {
      setStep(s => s + 1);
    }
  }, [step]);

  const handleFinish = useCallback(() => {
    setExiting(true);
    setTimeout(onComplete, reduced ? 0 : 300);
  }, [onComplete, reduced]);

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-ak-bg/95 backdrop-blur-sm',
        'transition-opacity duration-300',
        exiting ? 'opacity-0' : 'opacity-100',
      )}
    >
      {/* Background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={cn('absolute -top-20 -left-20 h-72 w-72 rounded-full bg-ak-primary/8 blur-blob', !reduced && 'animate-blob-drift')} />
        <div className={cn('absolute -bottom-20 -right-20 h-80 w-80 rounded-full bg-ak-primary/5 blur-blob', !reduced && 'animate-blob-drift-alt')} />
      </div>

      <div className="relative z-10 w-full max-w-md px-6">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 mb-8">
          {[0, 1, 2].map(i => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={cn(
                'h-2 rounded-full transition-all duration-300',
                i === step ? 'w-6 bg-ak-primary' : 'w-2 bg-ak-border hover:bg-ak-text-tertiary',
              )}
            />
          ))}
        </div>

        {/* Step content */}
        <div key={step} className={reduced ? '' : 'animate-scale-in'}>
          {step === 0 && (
            <div className="flex flex-col items-center text-center">
              <img
                src={LOGO_MARK_SVG}
                alt="AKIS"
                className={cn('h-24 w-24 mb-6', !reduced && 'animate-float-gentle')}
              />
              <h1 className="text-2xl font-bold text-ak-text-primary mb-3">
                AKIS'e Hoş Geldiniz
              </h1>
              <p className="text-sm text-ak-text-secondary leading-relaxed max-w-sm">
                AI destekli yazılım geliştirme platformunuz hazır. Fikrinizi anlatın, AKIS otomatik olarak spec yazacak, kod üretecek ve testleri oluşturacak.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col items-center">
              <h2 className="text-xl font-bold text-ak-text-primary mb-2 text-center">Nasıl Çalışır?</h2>
              <p className="text-xs text-ak-text-tertiary mb-6 text-center">3 AI agent sırayla çalışır</p>

              <div className="w-full space-y-3">
                <AgentFeatureCard
                  agent="scribe"
                  title="Scribe"
                  description="Fikrinizi detaylı bir spesifikasyona dönüştürür. Sorular sorar, netleştirir."
                  icon={<ScribeIcon />}
                  delay={reduced ? 0 : 0}
                />

                {/* Arrow */}
                <div className="flex justify-center py-1">
                  <div className={cn('h-4 w-px bg-ak-primary/30', !reduced && 'animate-draw-line')} />
                </div>

                <AgentFeatureCard
                  agent="proto"
                  title="Proto"
                  description="Onaylanan spec'e göre çalışır MVP kodu üretir ve GitHub'a push eder."
                  icon={<ProtoIcon />}
                  delay={reduced ? 0 : 200}
                />

                <div className="flex justify-center py-1">
                  <div className={cn('h-4 w-px bg-ak-primary/30', !reduced && 'animate-draw-line')} />
                </div>

                <AgentFeatureCard
                  agent="trace"
                  title="Trace"
                  description="Üretilen kodu okur, Playwright otomasyon testleri yazar."
                  icon={<TraceIcon />}
                  delay={reduced ? 0 : 400}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center text-center">
              <div className={cn(
                'mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-ak-primary/10',
                !reduced && 'animate-scale-in',
              )}>
                <svg className="h-10 w-10 text-ak-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-ak-text-primary mb-3">Hemen Başlayın</h2>
              <p className="text-sm text-ak-text-secondary leading-relaxed max-w-sm mb-6">
                Yazılım fikrinizi anlatarak ilk pipeline'ınızı başlatın. AKIS gerisini halledecek.
              </p>
              <button
                onClick={handleFinish}
                className={cn(
                  'rounded-xl bg-ak-primary px-8 py-3 text-sm font-semibold text-[color:var(--ak-on-primary)]',
                  'hover:brightness-110 active:brightness-95 transition-all',
                  'shadow-ak-glow',
                )}
              >
                İlk Pipeline'ımı Başlat
              </button>
              <button
                onClick={handleFinish}
                className="mt-3 text-xs text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
              >
                Daha sonra keşfet
              </button>
            </div>
          )}
        </div>

        {/* Next button (steps 0 and 1 only) */}
        {step < 2 && (
          <div className="flex justify-center mt-8">
            <button
              onClick={handleNext}
              className={cn(
                'rounded-xl bg-ak-primary/10 px-6 py-2.5 text-sm font-medium text-ak-primary',
                'hover:bg-ak-primary/20 transition-colors',
              )}
            >
              Devam
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
