import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../../components/common/Button';
import Logo from '../../components/branding/Logo';
import { clearReturnTo } from '../../utils/returnTo';

export default function WelcomeBeta() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  async function handleContinue() {
    setSubmitting(true);
    
    try {
      const { AuthAPI } = await import('../../services/api/auth');
      await AuthAPI.updatePreferences({ hasSeenBetaWelcome: true });
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to update preferences:', error);
      // Continue anyway - don't block user flow
    } finally {
      setSubmitting(false);
    }
    
    clearReturnTo();
    navigate('/chat', { replace: true });
  }

  function handleLearnMore() {
    // Open pricing page in new tab
    window.open('/pricing', '_blank');
  }

  return (
    <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-ak-surface-2 border border-ak-border rounded-2xl p-12 shadow-ak-md text-center">
        <div className="mb-6">
          <div className="mb-4 flex justify-center">
            <Logo size="nav" linkToHome={false} className="h-12" />
          </div>
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-3xl font-bold mb-2">AKIS'e Hoş Geldiniz!</h1>
          <p className="text-xl text-ak-primary font-semibold">Erken erişimdesiniz</p>
        </div>

        <div className="bg-ak-surface border border-ak-border rounded-xl p-6 mb-8 text-left">
          <p className="text-ak-text-secondary mb-4">
            AKIS şu anda <span className="text-ak-text-primary font-medium">beta</span> aşamasında. Tüm ajanlara (Scribe, Trace, Proto) bazı kullanım limitleriyle ücretsiz erişiminiz var:
          </p>

          <ul className="space-y-2 text-ak-text-secondary">
            <li className="flex items-start gap-2">
              <span className="text-ak-primary mt-0.5">•</span>
              <span>Ayda 100 iş akışı</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-ak-primary mt-0.5">•</span>
              <span>Topluluk desteği (Discord)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-ak-primary mt-0.5">•</span>
              <span>7 günlük log saklama</span>
            </li>
          </ul>

          <p className="text-ak-text-secondary mt-4 text-sm">
            Sınırsız iş akışı ve öncelikli destek içeren ücretli planlar 2026 Q2'de başlatılacak. Erken kullanıcılar ömür boyu indirim kazanır!
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button onClick={handleContinue} disabled={submitting} className="justify-center px-8">
            {submitting ? 'Yükleniyor...' : "AKIS Dashboard'a Git →"}
          </Button>
          <Button onClick={handleLearnMore} variant="outline" className="justify-center px-8">
            Fiyatlandırma hakkında bilgi al
          </Button>
        </div>
      </div>
    </main>
  );
}

