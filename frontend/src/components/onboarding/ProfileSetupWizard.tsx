import { useState, useCallback } from 'react';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { toast } from '../ui/Toast';
import { WizardShell } from './WizardShell';
import { StepProfile } from './steps/StepProfile';
import { StepGitHub } from './steps/StepGitHub';
import { StepAIProvider } from './steps/StepAIProvider';
import { StepPreferences } from './steps/StepPreferences';

interface ProfileSetupWizardProps {
  onClose: () => void;
}

export function ProfileSetupWizard({ onClose }: ProfileSetupWizardProps) {
  const { user } = useAuth();
  const [step, setStep] = useState(0);

  const handleProfileSave = useCallback(async (name: string) => {
    const res = await fetch('/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      toast('Profil kaydedilemedi. Tekrar deneyin.', 'error');
      return;
    }
    toast('Profil kaydedildi.', 'success');
    setStep(1);
  }, []);

  const handleGitHubConnect = useCallback(async (token: string) => {
    const res = await fetch('/api/github/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      toast('GitHub baglantisi basarisiz.', 'error');
      return;
    }
    toast('GitHub basariyla baglandi.', 'success');
  }, []);

  const handleAIKeySave = useCallback(async (provider: string, apiKey: string) => {
    const res = await fetch('/api/settings/ai-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider, apiKey }),
    });
    if (!res.ok) {
      toast('AI anahtari kaydedilemedi.', 'error');
      return;
    }
    toast('AI anahtari kaydedildi.', 'success');
  }, []);

  const handlePreferencesComplete = useCallback((locale: string) => {
    localStorage.setItem('akis-locale', locale);
    onClose();
  }, [onClose]);

  const stepLabels = ['Profil', 'GitHub', 'AI', 'Tercihler'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ak-bg/90 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-ak-border bg-ak-surface p-6 shadow-ak-elevation-3 animate-scale-in">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Step labels */}
        <div className="flex justify-center gap-4 mb-6">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold transition-colors',
                i < step ? 'bg-ak-primary text-[color:var(--ak-on-primary)]' :
                i === step ? 'bg-ak-primary/20 text-ak-primary' :
                'bg-ak-border text-ak-text-tertiary',
              )}>
                {i < step ? '✓' : i + 1}
              </div>
              <span className={cn(
                'text-[10px] font-medium hidden sm:inline',
                i === step ? 'text-ak-text-primary' : 'text-ak-text-tertiary',
              )}>
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div key={step} className="animate-slide-up">
          {step === 0 && (
            <StepProfile
              initialName={user?.name ?? ''}
              onSave={handleProfileSave}
            />
          )}
          {step === 1 && (
            <WizardShell
              currentStep={1}
              totalSteps={4}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
              showSkip
              onSkip={() => setStep(2)}
              nextLabel="Devam"
            >
              <StepGitHub
                onConnect={handleGitHubConnect}
                onSkip={() => setStep(2)}
              />
            </WizardShell>
          )}
          {step === 2 && (
            <WizardShell
              currentStep={2}
              totalSteps={4}
              onNext={() => setStep(3)}
              onBack={() => setStep(1)}
              showSkip
              onSkip={() => setStep(3)}
              nextLabel="Devam"
            >
              <StepAIProvider
                onSave={handleAIKeySave}
                onSkip={() => setStep(3)}
              />
            </WizardShell>
          )}
          {step === 3 && (
            <StepPreferences
              currentLocale={localStorage.getItem('akis-locale') ?? 'tr'}
              onComplete={handlePreferencesComplete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
