import { useState, useCallback } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { LOGO_MARK_SVG } from '../../theme/brand';

export default function ResetPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const passedEmail = (location.state as { email?: string })?.email ?? '';

  const [email, setEmail] = useState(passedEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = email.trim() && code.length === 6 && password.length >= 8 && password === confirmPassword;

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), code, newPassword: password }),
      });
      const data = await res.json();
      if (data.ok) {
        setSuccess(true);
      } else {
        setError(data.error?.message || 'Gecersiz veya suresi dolmus kod.');
      }
    } catch {
      setError('Sunucuya ulasilamadi.');
    } finally {
      setLoading(false);
    }
  }, [email, code, password, isValid]);

  if (success) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-ak-bg px-4">
        <img src={LOGO_MARK_SVG} alt="AKIS" className="mb-6 h-12 w-12" />
        <div className="w-full max-w-sm rounded-2xl border border-ak-border bg-ak-surface p-6 text-center">
          <div className="mb-3 text-3xl">✅</div>
          <h1 className="mb-2 text-xl font-bold text-ak-text-primary">Sifre Guncellendi</h1>
          <p className="mb-4 text-sm text-ak-text-secondary">
            Sifreniz basariyla degistirildi. Yeni sifrenizle giris yapabilirsiniz.
          </p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="w-full rounded-lg bg-ak-primary px-4 py-2.5 text-sm font-semibold text-[#0A1215] hover:brightness-110 transition"
          >
            Giris Yap
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ak-bg px-4">
      <img src={LOGO_MARK_SVG} alt="AKIS" className="mb-6 h-12 w-12" />
      <div className="w-full max-w-sm rounded-2xl border border-ak-border bg-ak-surface p-6">
        <h1 className="mb-1 text-xl font-bold text-ak-text-primary">Sifre Sifirlama</h1>
        <p className="mb-5 text-sm text-ak-text-secondary">
          E-postaniza gelen 6 haneli kodu ve yeni sifrenizi girin.
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!passedEmail && (
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
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-ak-text-secondary">Dogrulama Kodu</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              required
              className="w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2.5 text-center text-lg font-mono tracking-[0.5em] text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ak-text-secondary">Yeni Sifre</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="En az 8 karakter, 1 buyuk harf, 1 rakam"
              required
              className="w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2.5 text-sm text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ak-text-secondary">Sifre Tekrar</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Sifrenizi tekrar girin"
              required
              className="w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2.5 text-sm text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
            />
            {confirmPassword && password !== confirmPassword && (
              <p className="mt-1 text-xs text-red-400">Sifreler eslesmiyor</p>
            )}
          </div>
          <button
            type="submit"
            disabled={loading || !isValid}
            className="w-full rounded-lg bg-ak-primary px-4 py-2.5 text-sm font-semibold text-[#0A1215] hover:brightness-110 transition disabled:opacity-50"
          >
            {loading ? 'Guncelleniyor...' : 'Sifreyi Guncelle'}
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
