import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import Button from '../../components/common/Button';
import { LOGO_MARK_SVG } from '../../theme/brand';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/i18n.types';
import { getAuthBaseUrl } from '../../services/api/config';
import { clearReturnTo, setReturnTo } from '../../utils/returnTo';

const OAUTH_ERROR_MAP: Record<string, string> = {
  oauth_invalid_state: 'auth.oauth.error.invalidState',
  oauth_missing_code: 'auth.oauth.error.missingCode',
  oauth_not_configured: 'auth.oauth.error.notConfigured',
  oauth_failed: 'auth.oauth.error.failed',
  oauth_missing_email: 'auth.oauth.error.missingEmail',
  oauth_db_not_migrated: 'auth.oauth.error.dbNotMigrated',
  account_disabled: 'auth.oauth.error.accountDisabled',
  account_not_found: 'auth.oauth.error.accountNotFound',
  email_not_verified: 'auth.oauth.error.emailNotVerified',
};

export default function LoginEmail() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useI18n();

  useEffect(() => {
    const from = (location.state as { from?: { pathname?: string } })?.from?.pathname;
    if (from) {
      setReturnTo(from);
    } else {
      // Clear stale redirect targets when login is opened directly.
      clearReturnTo();
    }
  }, [location.state]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [oauthError, setOauthError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      const i18nKey = OAUTH_ERROR_MAP[errorParam];
      if (i18nKey) {
        setOauthError(t(i18nKey as MessageKey));
      } else if (errorParam.startsWith('oauth_')) {
        setOauthError(t('auth.oauth.error.providerError'));
      } else {
        setOauthError(t('auth.oauth.error.generic'));
      }
      searchParams.delete('error');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, t]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setOauthError('');
    setSubmitting(true);

    try {
      const { AuthAPI } = await import('../../services/api/auth');
      const response = await AuthAPI.loginStart({ email });

      sessionStorage.setItem(
        'akis_login_data',
        JSON.stringify({
          userId: response.userId,
          email: response.email,
        })
      );

      navigate('/login/password');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Devam edilemiyor. Lütfen tekrar deneyin.';

      try {
        const errorData = JSON.parse(errorMessage);

        if (errorData.code === 'EMAIL_NOT_VERIFIED' && errorData.userId) {
          sessionStorage.setItem(
            'akis_signup_data',
            JSON.stringify({
              userId: errorData.userId,
              email,
            })
          );
          setError('E-posta doğrulanmadı. Doğrulama sayfasına yönlendiriliyor...');
          setTimeout(() => navigate('/signup/verify-email'), 2000);
          return;
        }

        setError(errorData.error || errorData.message || errorMessage);
      } catch {
        setError(errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleOAuthLogin(provider: 'github' | 'google') {
    const from = (location.state as { from?: { pathname?: string } })?.from?.pathname;
    if (from) {
      setReturnTo(from);
    } else {
      clearReturnTo();
    }
    window.location.href = `${getAuthBaseUrl()}/auth/oauth/${provider}`;
  }

  function dismissOAuthError() {
    setOauthError('');
  }

  return (
    <main className="relative min-h-screen bg-ak-bg text-ak-text-primary flex items-center justify-center px-4 overflow-hidden">
      {/* Subtle background blobs */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full bg-ak-primary/[0.04] blur-blob animate-blob-drift" />
        <div className="absolute -bottom-40 -right-40 h-[400px] w-[400px] rounded-full bg-ak-primary/[0.03] blur-blob animate-blob-drift-alt" />
      </div>

      <div className="relative w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-ak-border bg-ak-surface/80 backdrop-blur-lg p-8 shadow-ak-lg">
          <div className="mb-6 flex justify-center">
            <img src={LOGO_MARK_SVG} alt="AKIS" className="h-14 w-auto" />
          </div>

          <h1 className="text-heading text-center font-semibold text-ak-text-primary mb-1">
            {t('auth.login.title')}
          </h1>
          <p className="text-body text-ak-text-secondary text-center mb-6">
            {t('auth.login.subtitle')}
          </p>

          {/* OAuth Error Banner */}
          {oauthError && (
            <div className="mb-6 p-3 bg-ak-danger/10 border border-ak-danger/20 rounded-xl flex items-start gap-3">
              <svg
                className="w-5 h-5 text-ak-danger flex-shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div className="flex-1">
                <p className="text-body text-ak-danger font-medium">{oauthError}</p>
                <p className="text-caption text-ak-text-secondary mt-1">
                  {t('auth.oauth.error.tryAgain')}
                </p>
              </div>
              <button
                type="button"
                onClick={dismissOAuthError}
                className="text-ak-text-tertiary hover:text-ak-text-primary transition-colors"
                aria-label={t('auth.oauth.error.dismiss')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* OAuth Buttons */}
          <div className="space-y-3 mb-6">
            <button
              type="button"
              onClick={() => handleOAuthLogin('google')}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-ak-border rounded-xl bg-ak-surface text-ak-text-primary transition-all duration-150 hover:bg-ak-hover hover:border-ak-border-strong"
              aria-label={t('auth.oauth.google')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              <span className="text-body font-medium">{t('auth.oauth.google')}</span>
            </button>

            <button
              type="button"
              onClick={() => handleOAuthLogin('github')}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-ak-border rounded-xl bg-ak-surface text-ak-text-primary transition-all duration-150 hover:bg-ak-hover hover:border-ak-border-strong"
              aria-label={t('auth.oauth.github')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <span className="text-body font-medium">{t('auth.oauth.github')}</span>
            </button>
          </div>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-ak-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-ak-surface text-ak-text-tertiary text-caption">
                {t('auth.oauth.or')}
              </span>
            </div>
          </div>

          {/* Email Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-caption font-medium text-ak-text-secondary" htmlFor="email">
                {t('auth.email.label')}
              </label>
              <input
                id="email"
                className="w-full border border-ak-border bg-ak-bg text-ak-text-primary px-4 py-3 rounded-xl transition-all duration-150 focus:border-ak-primary focus:ring-2 focus:ring-ak-primary/20 outline-none placeholder-ak-text-tertiary"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !submitting && email.length > 0) {
                    e.preventDefault();
                    handleSubmit(e as unknown as React.FormEvent<HTMLFormElement>);
                  }
                }}
                required
                autoComplete="email"
                placeholder={t('auth.email.placeholder')}
              />
            </div>

            {error ? <p className="text-ak-danger text-body">{error}</p> : null}

            <Button type="submit" disabled={submitting} className="w-full justify-center">
              {submitting ? t('auth.login.checking') : t('auth.login.continue')}
            </Button>
          </form>

          <p className="mt-6 text-ak-text-secondary text-body text-center">
            {t('auth.login.noAccount')}{' '}
            <Link className="text-ak-primary hover:underline font-medium" to="/signup">
              {t('auth.login.signUp')}
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
