import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import { ProtectedRoute } from './app/RouteGuards';
import { AuthProvider } from './contexts/AuthContext';
import { useI18n } from './i18n/useI18n';
import { ToastContainer } from './components/ui/Toast';

// Auth pages — lazy
const LoginEmail = lazy(() => import('./pages/auth/LoginEmail'));
const LoginPassword = lazy(() => import('./pages/auth/LoginPassword'));
const SignupEmail = lazy(() => import('./pages/auth/SignupEmail'));
const SignupPassword = lazy(() => import('./pages/auth/SignupPassword'));
const SignupVerifyEmail = lazy(() => import('./pages/auth/SignupVerifyEmail'));
const WelcomeBeta = lazy(() => import('./pages/auth/WelcomeBeta'));
const PrivacyConsent = lazy(() => import('./pages/auth/PrivacyConsent'));
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

// Engineer Rental Mode — protected pages
const EngineerPage = lazy(() => import('./pages/engineer/EngineerPage'));
const EngineerSessionPage = lazy(() => import('./pages/engineer/EngineerSessionPage'));

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

          {/* Public Routes */}
          <Route element={<AppShell />}>
            <Route path="legal">
              <Route path="terms" element={<Suspense fallback={<PageLoader />}><LegalTermsPage /></Suspense>} />
              <Route path="privacy" element={<Suspense fallback={<PageLoader />}><LegalPrivacyPage /></Suspense>} />
            </Route>
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
            <Route path="auth">
              <Route path="welcome-beta" element={<Suspense fallback={<PageLoader />}><WelcomeBeta /></Suspense>} />
              <Route path="privacy-consent" element={<Suspense fallback={<PageLoader />}><PrivacyConsent /></Suspense>} />
              <Route path="invite/:token" element={<Suspense fallback={<PageLoader />}><InviteAccept /></Suspense>} />
            </Route>
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

          {/* Engineer Rental Mode — protected pages */}
          <Route
            path="/engineer"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><EngineerPage /></Suspense>
              </ProtectedRoute>
            }
          />
          <Route
            path="/engineer/session/:id"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><EngineerSessionPage /></Suspense>
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
