import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Button from '../../components/common/Button';
import Logo from '../../components/branding/Logo';
import { useI18n } from '../../i18n/useI18n';

type InviteInfo = {
  email: string;
  inviterName: string;
  expiresAt: string;
  existingUser: boolean;
};

export default function InviteAccept() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { locale } = useI18n();

  const [loading, setLoading] = useState(true);
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [invalidReason, setInvalidReason] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setInvalidReason(locale === 'tr' ? 'Davet bağlantısı eksik.' : 'Invite link is missing.');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const { AuthAPI } = await import('../../services/api/auth');
        const result = await AuthAPI.validateInvite(token);

        if (result.valid && result.email) {
          setInviteInfo({
            email: result.email,
            inviterName: result.inviterName ?? 'AKIS Admin',
            expiresAt: result.expiresAt ?? '',
            existingUser: result.existingUser ?? false,
          });
        } else {
          setInvalidReason(
            locale === 'tr'
              ? 'Bu davet bağlantısı geçersiz veya süresi dolmuş.'
              : 'This invite link is invalid or expired.',
          );
        }
      } catch {
        setInvalidReason(
          locale === 'tr'
            ? 'Davet doğrulanamadı. Lütfen tekrar deneyin.'
            : 'Could not validate invite. Please try again.',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [token, locale]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(locale === 'tr' ? 'Şifreler eşleşmiyor.' : 'Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError(locale === 'tr' ? 'Şifre en az 8 karakter olmalıdır.' : 'Password must be at least 8 characters.');
      return;
    }

    setSubmitting(true);

    try {
      const { AuthAPI } = await import('../../services/api/auth');
      await AuthAPI.acceptInvite({
        token: token!,
        firstName,
        lastName,
        password,
      });

      // Invite accepted — go straight to chat
      navigate('/chat');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Loading state
  if (loading) {
    return (
      <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md text-center">
          <div className="mb-6 flex justify-center">
            <Logo size="nav" linkToHome={false} className="h-12" />
          </div>
          <div className="h-8 w-8 mx-auto animate-spin rounded-full border-2 border-ak-primary border-t-transparent" />
          <p className="mt-4 text-ak-text-secondary">
            {locale === 'tr' ? 'Davet doğrulanıyor...' : 'Validating invite...'}
          </p>
        </div>
      </main>
    );
  }

  // Invalid invite
  if (invalidReason || !inviteInfo) {
    return (
      <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md text-center">
          <div className="mb-6 flex justify-center">
            <Logo size="nav" linkToHome={false} className="h-12" />
          </div>
          <div className="text-4xl mb-4">&#128683;</div>
          <h1 className="text-h2 mb-2">
            {locale === 'tr' ? 'Geçersiz Davet' : 'Invalid Invite'}
          </h1>
          <p className="text-ak-text-secondary mb-6">{invalidReason}</p>
          <Link
            to="/signup"
            className="text-ak-primary hover:underline font-medium"
          >
            {locale === 'tr' ? 'Yeni hesap oluştur' : 'Create a new account'}
          </Link>
        </div>
      </main>
    );
  }

  // Existing user — redirect to login
  if (inviteInfo.existingUser) {
    return (
      <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md text-center">
          <div className="mb-6 flex justify-center">
            <Logo size="nav" linkToHome={false} className="h-12" />
          </div>
          <h1 className="text-h2 mb-2">
            {locale === 'tr' ? 'Zaten Hesabınız Var' : 'You Already Have an Account'}
          </h1>
          <p className="text-ak-text-secondary mb-4">
            {locale === 'tr'
              ? `${inviteInfo.inviterName} sizi davet etti. Mevcut hesabınızla giriş yapabilirsiniz.`
              : `${inviteInfo.inviterName} invited you. You can log in with your existing account.`}
          </p>
          <p className="text-sm text-ak-text-secondary mb-6">{inviteInfo.email}</p>
          <Link to="/login">
            <Button className="w-full justify-center">
              {locale === 'tr' ? 'Giriş Yap' : 'Log In'}
            </Button>
          </Link>
        </div>
      </main>
    );
  }

  // Accept invite form
  return (
    <main className="min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-ak-surface-2 border border-ak-border rounded-2xl p-8 shadow-ak-md">
        <div className="mb-6 flex justify-center">
          <Logo size="nav" linkToHome={false} className="h-12" />
        </div>

        <h1 className="text-h2 mb-2">
          {locale === 'tr' ? 'Daveti Kabul Et' : 'Accept Invite'}
        </h1>
        <p className="text-sm text-ak-text-secondary mb-1">
          {locale === 'tr'
            ? `${inviteInfo.inviterName} sizi AKIS Platform'a davet etti.`
            : `${inviteInfo.inviterName} invited you to AKIS Platform.`}
        </p>
        <p className="text-sm text-ak-primary font-medium mb-6">{inviteInfo.email}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="firstName">
              {locale === 'tr' ? 'Ad' : 'First Name'}
            </label>
            <input
              id="firstName"
              className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              autoComplete="given-name"
              placeholder={locale === 'tr' ? 'Adınız' : 'Your first name'}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="lastName">
              {locale === 'tr' ? 'Soyad' : 'Last Name'}
            </label>
            <input
              id="lastName"
              className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              autoComplete="family-name"
              placeholder={locale === 'tr' ? 'Soyadınız' : 'Your last name'}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="password">
              {locale === 'tr' ? 'Şifre' : 'Password'}
            </label>
            <input
              id="password"
              className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder={locale === 'tr' ? 'En az 8 karakter' : 'At least 8 characters'}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="confirmPassword">
              {locale === 'tr' ? 'Şifre Tekrar' : 'Confirm Password'}
            </label>
            <input
              id="confirmPassword"
              className="w-full border border-ak-border bg-ak-surface text-ak-text-primary px-4 py-3 rounded-xl focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/70 outline-none transition-colors"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder={locale === 'tr' ? 'Şifrenizi tekrar girin' : 'Repeat your password'}
            />
          </div>

          {error ? <p className="text-ak-danger text-sm">{error}</p> : null}

          <Button type="submit" disabled={submitting} className="w-full justify-center">
            {submitting
              ? (locale === 'tr' ? 'Hesap oluşturuluyor...' : 'Creating account...')
              : (locale === 'tr' ? 'Hesap Oluştur' : 'Create Account')}
          </Button>
        </form>

        <p className="mt-6 text-ak-text-secondary text-sm text-center">
          {locale === 'tr' ? 'Zaten hesabınız var mı?' : 'Already have an account?'}{' '}
          <Link className="text-ak-primary hover:underline font-medium" to="/login">
            {locale === 'tr' ? 'Giriş yap' : 'Log in'}
          </Link>
        </p>
      </div>
    </main>
  );
}
