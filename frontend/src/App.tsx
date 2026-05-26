import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import { ProtectedRoute, RedirectIfAuthenticated } from './app/RouteGuards';
import { AuthProvider } from './contexts/AuthContext';
import { useI18n } from './i18n/useI18n';
import { ToastContainer } from './components/ui/Toast';

// Auth pages — lazy
const LoginEmail = lazy(() => import('./pages/auth/LoginEmail'));
const LoginPassword = lazy(() => import('./pages/auth/LoginPassword'));
const SignupEmail = lazy(() => import('./pages/auth/SignupEmail'));
const SignupPassword = lazy(() => import('./pages/auth/SignupPassword'));
const SignupVerifyEmail = lazy(() => import('./pages/auth/SignupVerifyEmail'));
const InviteAccept = lazy(() => import('./pages/auth/InviteAccept'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));

// Legal pages
const LegalTermsPage = lazy(() => import('./pages/legal/LegalTermsPage'));
const LegalPrivacyPage = lazy(() => import('./pages/legal/LegalPrivacyPage'));

// Chat — primary page
const ChatPage = lazy(() => import('./pages/chat/ChatPage'));

// Landing & Docs — public pages (FAZ 7 placeholders)
const LandingPage = lazy(() => import('./pages/LandingPage'));
const DocsPage = lazy(() => import('./pages/DocsPage'));

// Protected pages
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));

const PageLoader = () => (
  <div className="flex min-h-[200px] items-center justify-center animate-in fade-in duration-200">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-ak-primary border-t-transparent" />
  </div>
);

function App() {
  const { t } = useI18n();

  useEffect(() => {
    document.title = t('app.title');
  }, [t]);

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Landing page — public */}
          <Route index element={<Suspense fallback={<PageLoader />}><LandingPage /></Suspense>} />

          {/* Public + auth-onboarding routes — share AppShell chrome */}
          <Route element={<AppShell />}>
            {/* Legal — fully public */}
            <Route path="legal">
              <Route path="terms" element={<Suspense fallback={<PageLoader />}><LegalTermsPage /></Suspense>} />
              <Route path="privacy" element={<Suspense fallback={<PageLoader />}><LegalPrivacyPage /></Suspense>} />
            </Route>

            {/*
              Auth-entry routes — only meaningful for users WITHOUT a session.
              An authenticated user hitting /login bounces to /chat instead of
              seeing a login form for the account they already have.
            */}
            <Route element={<RedirectIfAuthenticated />}>
              <Route path="login">
                <Route index element={<Suspense fallback={<PageLoader />}><LoginEmail /></Suspense>} />
                <Route path="password" element={<Suspense fallback={<PageLoader />}><LoginPassword /></Suspense>} />
              </Route>
              <Route path="signup">
                <Route index element={<Suspense fallback={<PageLoader />}><SignupEmail /></Suspense>} />
                <Route path="password" element={<Suspense fallback={<PageLoader />}><SignupPassword /></Suspense>} />
                <Route path="verify-email" element={<Suspense fallback={<PageLoader />}><SignupVerifyEmail /></Suspense>} />
              </Route>
              <Route path="forgot-password" element={<Suspense fallback={<PageLoader />}><ForgotPassword /></Suspense>} />
              <Route path="reset-password" element={<Suspense fallback={<PageLoader />}><ResetPassword /></Suspense>} />
            </Route>

            {/*
              Invite acceptance is intentionally public: the token in the URL
              IS the auth credential — the user does not have an account yet.
            */}
            <Route path="auth/invite/:token" element={<Suspense fallback={<PageLoader />}><InviteAccept /></Suspense>} />
          </Route>

          {/* Docs — public */}
          <Route path="/docs" element={<Suspense fallback={<PageLoader />}><DocsPage /></Suspense>} />

          {/* Chat Route — single mount, no remount on chat switch */}
          <Route
            path="/chat/*"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><ChatPage /></Suspense>
              </ProtectedRoute>
            }
          />

          {/* Settings — standalone protected page */}
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>
              </ProtectedRoute>
            }
          />

          {/* Analytics — standalone protected page */}
          <Route
            path="/analytics"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><AnalyticsPage /></Suspense>
              </ProtectedRoute>
            }
          />

          {/* Catch-all → landing */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ToastContainer />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
