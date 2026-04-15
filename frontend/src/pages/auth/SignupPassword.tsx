import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Button from '../../components/common/Button';
import Logo from '../../components/branding/Logo';

export default function SignupPassword() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Get signup data from sessionStorage
    const storedData = sessionStorage.getItem('akis_signup_data');
    if (!storedData) {
      // No data found, redirect back to step 1
      navigate('/signup');
      return;
    }
    const data = JSON.parse(storedData);
    setEmail(data.email);
  }, [navigate]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Şifreler eşleşmiyor');
      return;
    }

    // Validate password strength
    if (password.length < 8) {
      setError('Şifre en az 8 karakter olmalıdır');
      return;
    }
    if (!/[A-Z]/.test(password)) {
      setError('Şifre en az 1 büyük harf içermelidir');
      return;
    }
    if (!/\d/.test(password)) {
      setError('Şifre en az 1 rakam içermelidir');
      return;
    }

    setSubmitting(true);

    try {
      const storedData = sessionStorage.getItem('akis_signup_data');
      if (!storedData) {
        throw new Error('Kayıt oturumu sona erdi. Lütfen tekrar başlatın.');
      }

      const data = JSON.parse(storedData);
      const { AuthAPI } = await import('../../services/api/auth');
      
      const response = await AuthAPI.signupPassword({
        userId: data.userId,
        password,
      });

      if (response.verificationBypassed && response.user) {
        setUser(response.user);
        sessionStorage.removeItem('akis_signup_data');

        if (response.needsDataSharingConsent) {
          navigate('/auth/privacy-consent');
        } else if (!response.user.hasSeenBetaWelcome) {
          navigate('/auth/welcome-beta');
        } else {
          navigate('/dashboard');
        }
        return;
      }

      // Default flow: navigate to email verification step
      navigate('/signup/verify-email');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Şifre belirlenemedi. Lütfen tekrar deneyin.';
      
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
    navigate('/signup');
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

        <h1 className="text-h2 mb-2">Şifre oluşturun</h1>
        <p className="text-sm text-ak-text-secondary mb-6">
          <span className="text-ak-text-primary font-medium">{email}</span> için
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="password">
              Şifre (en az 8 karakter)
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
                autoComplete="new-password"
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

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="confirmPassword">
              Şifre tekrar
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 pr-16 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium uppercase tracking-wide text-ak-text-secondary hover:text-ak-primary focus:outline-none focus:ring-2 focus:ring-ak-primary focus:ring-offset-0 px-2 py-1 rounded transition-colors"
                aria-label={showConfirmPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
              >
                {showConfirmPassword ? 'GİZLE' : 'GÖSTER'}
              </button>
            </div>
          </div>

          {error ? <p className="text-ak-danger text-sm">{error}</p> : null}

          <Button type="submit" disabled={submitting} className="w-full justify-center">
            {submitting ? 'Şifre ayarlanıyor...' : 'Devam et'}
          </Button>
        </form>
      </div>
    </main>
  );
}

