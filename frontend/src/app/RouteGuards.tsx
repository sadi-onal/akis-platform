import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n/useI18n';
import { POST_AUTH_PATH } from './routes';

// PR-U2 M12: small helper so all three route guards share the same i18n'd
// loading view without duplicating the markup.
function GuardLoading() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="flex min-h-[50vh] items-center justify-center text-sm text-ak-text-secondary"
    >
      {t('app.loading')}
    </div>
  );
}

type Role = 'admin' | 'member';

type ProtectedRouteProps = {
  children?: ReactNode;
};

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const location = useLocation();
  const { user, loading } = useAuth();
  const isAuthenticated = Boolean(user);

  if (loading) {
    return <GuardLoading />;
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          from: location,
          message: 'Devam etmek için lütfen oturum aç.',
        }}
      />
    );
  }

  return children ? <>{children}</> : <Outlet />;
}

/**
 * Inverse of ProtectedRoute: a route that is meaningless once you have a
 * session (login form, signup form, password reset form). Redirects an
 * already-authenticated user to the chat.
 */
type RedirectIfAuthenticatedProps = {
  children?: ReactNode;
};

export function RedirectIfAuthenticated({ children }: RedirectIfAuthenticatedProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return <GuardLoading />;
  }

  if (user) {
    return <Navigate to={POST_AUTH_PATH} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}

type RequireRoleProps = {
  roles: Role[];
  fallbackPath?: string;
  children?: ReactNode;
};

export function RequireRole({ roles, fallbackPath = POST_AUTH_PATH, children }: RequireRoleProps) {
  const location = useLocation();
  const { user, loading } = useAuth();
  const isAuthenticated = Boolean(user);

  if (loading) {
    return <GuardLoading />;
  }

  if (!isAuthenticated || !user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          from: location,
          message: 'Devam etmek için oturum açmalısınız.',
        }}
      />
    );
  }

  const role = user.role ?? 'member';

  if (!roles.includes(role)) {
    return (
      <Navigate
        to={fallbackPath}
        replace
        state={{
          from: location,
          message: 'Bu alan için gerekli yetkilere sahip değilsiniz.',
        }}
      />
    );
  }

  return children ? <>{children}</> : <Outlet />;
}
