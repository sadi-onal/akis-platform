import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LOGO_MARK_SVG } from '../../theme/brand';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setSent(true);
        if (data.userId) setUserId(data.userId);
      } else {
        setError(data.error?.message || 'Bir hata olustu.');
      }
    } catch {
      setError('Sunucuya ulasilamadi.');
    } finally {
      setLoading(false);
    }
  }, [email]);

  if (sent) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-ak-bg px-4">
        <img src={LOGO_MARK_SVG} alt="AKIS" className="mb-6 h-12 w-12" />
        <div className="w-full max-w-sm rounded-2xl border border-ak-border bg-ak-surface p-6 text-center">
          <h1 className="mb-2 text-xl font-bold text-ak-text-primary">Kod Gonderildi</h1>
          <p className="mb-4 text-sm text-ak-text-secondary">
            <strong>{email}</strong> adresine 6 haneli sifre sifirlama kodu gonderdik.
          </p>
          <button
            onClick={() => navigate('/reset-password', { state: { email, userId } })}
            className="w-full rounded-lg bg-ak-primary px-4 py-2.5 text-sm font-semibold text-[#0A1215] hover:brightness-110 transition"
          >
            Kodu Gir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ak-bg px-4">
      <img src={LOGO_MARK_SVG} alt="AKIS" className="mb-6 h-12 w-12" />
      <div className="w-full max-w-sm rounded-2xl border border-ak-border bg-ak-surface p-6">
        <h1 className="mb-1 text-xl font-bold text-ak-text-primary">Sifremi Unuttum</h1>
        <p className="mb-5 text-sm text-ak-text-secondary">
          Kayitli e-posta adresinizi girin, size sifre sifirlama kodu gonderelim.
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-ak-text-secondary">E-posta</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ornek@email.com"
              required
              className="w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2.5 text-sm text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="w-full rounded-lg bg-ak-primary px-4 py-2.5 text-sm font-semibold text-[#0A1215] hover:brightness-110 transition disabled:opacity-50"
          >
            {loading ? 'Gonderiliyor...' : 'Sifirlama Kodu Gonder'}
          </button>
        </form>

        <div className="mt-4 text-center">
          <Link to="/login" className="text-xs text-ak-text-tertiary hover:text-ak-primary transition-colors">
            ← Giris sayfasina don
          </Link>
        </div>
      </div>
    </div>
  );
}
