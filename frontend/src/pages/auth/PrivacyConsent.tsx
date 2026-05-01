import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../../components/common/Button';
import Logo from '../../components/branding/Logo';
import { getReturnTo, clearReturnTo, setReturnTo } from '../../utils/returnTo';
import { POST_AUTH_PATH } from '../../app/routes';

export default function PrivacyConsent() {
  const navigate = useNavigate();
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleContinue() {
    setSubmitting(true);

    try {
      const { AuthAPI } = await import('../../services/api/auth');
      await AuthAPI.updatePreferences({ dataSharingConsent: consent });

      const user = await AuthAPI.me();
      const returnTo = getReturnTo();
      if (!user.hasSeenBetaWelcome) {
        if (returnTo) setReturnTo(returnTo);
        navigate('/auth/welcome-beta', { replace: true });
      } else {
        clearReturnTo();
        navigate(returnTo || POST_AUTH_PATH, { replace: true });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to update preferences:', err);
      const returnTo = getReturnTo();
      if (returnTo) setReturnTo(returnTo);
      navigate('/auth/welcome-beta', { replace: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md">
        <div className="mb-6 flex justify-center">
          <Logo size="nav" linkToHome={false} className="h-12" />
        </div>

        <h1 className="text-h2 mb-4">AKIS'i geliştirmemize yardımcı olun</h1>

        <div className="space-y-6 mb-8 text-ak-text-secondary">
          <p>
            AKIS, platformu geliştirmek için anonimleştirilmiş kullanım verileri toplayabilir. Bunlar:
          </p>

          <div className="bg-ak-surface border border-ak-border rounded-xl p-6">
            <h3 className="text-sm font-semibold text-ak-text-primary mb-3">
              ✓ Topladıklarımız (onay verirseniz):
            </h3>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-ak-primary mt-0.5">•</span>
                <span>Ajan iş türleri ve başarı oranları</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-ak-primary mt-0.5">•</span>
                <span>Özellik kullanımı (hangi sayfaları ziyaret ettiğiniz)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-ak-primary mt-0.5">•</span>
                <span>Hata kayıtları (anonimleştirilmiş stack trace'ler)</span>
              </li>
            </ul>
          </div>

          <div className="bg-ak-surface border border-ak-border rounded-xl p-6">
            <h3 className="text-sm font-semibold text-ak-text-primary mb-3">
              ✗ Asla toplamadıklarımız:
            </h3>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-ak-danger mt-0.5">✗</span>
                <span>Kodunuz veya depo içerikleriniz</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-ak-danger mt-0.5">✗</span>
                <span>Jira/Confluence verileri</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-ak-danger mt-0.5">✗</span>
                <span>Entegrasyon tokenları veya kimlik bilgileri</span>
              </li>
            </ul>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1 w-5 h-5 rounded border-ak-border bg-ak-surface text-ak-primary focus:ring-2 focus:ring-ak-primary focus:ring-offset-0 focus:ring-offset-ak-surface-2 transition-colors"
            />
            <span className="text-sm">
              AKIS'in ürünü geliştirmek için anonimleştirilmiş kullanım verilerimi kullanmasına izin veriyorum.
              Bunu istediğim zaman{' '}
              <span className="text-ak-text-primary font-medium">Ayarlar → Gizlilik</span> bölümünden değiştirebilirim.
            </span>
          </label>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            onClick={handleContinue}
            disabled={submitting}
            className="flex-1 justify-center"
          >
            {submitting ? 'Kaydediliyor...' : "Dashboard'a Devam Et"}
          </Button>
          <a
            href="/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-ak-primary hover:underline text-center py-3"
          >
            Gizlilik hakkında daha fazla bilgi
          </a>
        </div>
      </div>
    </main>
  );
}

