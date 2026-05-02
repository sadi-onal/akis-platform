import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Button from '../../components/common/Button';
import Logo from '../../components/branding/Logo';
import { getReturnTo, clearReturnTo } from '../../utils/returnTo';
import { POST_AUTH_PATH } from '../../app/routes';

export default function LoginPassword() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Get login data from sessionStorage (set in LoginEmail step)
    const storedData = sessionStorage.getItem('akis_login_data');
    if (!storedData) {
      // No data found, redirect back to step 1
      navigate('/login');
      return;
    }
    try {
      const data = JSON.parse(storedData);
      if (!data?.email || !data?.userId) throw new Error('invalid');
      setEmail(data.email);
      setUserId(data.userId);
    } catch {
      sessionStorage.removeItem('akis_login_data');
      navigate('/login');
      return;
    }
  }, [navigate]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const { AuthAPI } = await import('../../services/api/auth');
      const response = await AuthAPI.loginComplete({
        userId,
        password,
      });

      // Update auth context with user data
      setUser(response.user);

      sessionStorage.removeItem('akis_login_data');
      const returnTo = getReturnTo();
      clearReturnTo();
      navigate(returnTo || POST_AUTH_PATH, { replace: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Yanlış şifre. Lütfen tekrar deneyin.';
      
      // Try to parse error JSON for better messages
      try {
        const errorData = JSON.parse(errorMessage);
        setError(errorData.error || errorData.message || errorMessage);
      } catch {
        setError(errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    navigate('/login');
  }

  if (!email) {
    return null; // Will redirect in useEffect
  }

  return (
    <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-2 text-sm text-ak-text-secondary hover:text-ak-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Geri
          </button>

          <Logo size="nav" linkToHome={false} className="h-12" />
        </div>

        <h1 className="text-h2 mb-2">Şifrenizi girin</h1>
        <p className="text-sm text-ak-text-secondary mb-6">
          <span className="text-ak-text-primary font-medium">{email}</span> olarak giriş yapılıyor
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="password">
              Şifre
            </label>
            <div className="relative">
              <input
                id="password"
                className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 pr-16 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="current-password"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium uppercase tracking-wide text-ak-text-secondary hover:text-ak-primary focus:outline-none focus:ring-2 focus:ring-ak-primary focus:ring-offset-0 px-2 py-1 rounded transition-colors"
                aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
              >
                {showPassword ? 'GİZLE' : 'GÖSTER'}
              </button>
            </div>
          </div>

          <div className="flex justify-end">
            <Link
              to="/forgot-password"
              className="text-sm text-ak-primary hover:underline"
            >
              Şifremi unuttum
            </Link>
          </div>

          {error ? <p className="text-ak-danger text-sm">{error}</p> : null}

          <Button type="submit" disabled={submitting} className="w-full justify-center">
            {submitting ? 'Giriş yapılıyor...' : 'Giriş yap'}
          </Button>
        </form>
      </div>
    </main>
  );
}

