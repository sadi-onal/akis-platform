import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/common/Button';

const dashboardLinks = [
  { label: 'Overview', to: '/dashboard' },
  { label: 'Agents', to: '/agents' },
  { label: 'Isler', to: '/dashboard/jobs' },
  { label: 'Entegrasyonlar', to: '/dashboard/integrations' },
  { label: 'Ayarlar', to: '/dashboard/settings/profile' },
];

const settingsLinks = [
  { label: 'Profile', to: '/dashboard/settings/profile' },
  { label: 'Workspace', to: '/dashboard/settings/workspace' },
  { label: 'API Keys', to: '/dashboard/settings/api-keys' },
  { label: 'Billing', to: '/dashboard/settings/billing' },
  { label: 'Notifications', to: '/dashboard/settings/notifications' },
];

const DashboardShell = () => {
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const workspaceLabel = user?.email ?? 'AKIS Team';

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      if (isMountedRef.current) {
        setIsLoggingOut(false);
      }
    }
  };

  return (
    <div className="flex min-h-screen bg-ak-bg text-ak-text-primary">
      <aside className="hidden min-h-screen w-72 flex-shrink-0 border-r border-ak-border bg-ak-surface p-6 lg:block">
        <div className="mb-8 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ak-text-secondary/70">
            Workspace
          </p>
          <p className="text-lg font-semibold text-ak-text-primary">{workspaceLabel}</p>
          <p className="text-sm text-ak-text-secondary">{user?.email}</p>
        </div>

        <nav className="space-y-6 text-sm font-medium">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-ak-text-secondary/70">
              Main
            </p>
            <ul className="space-y-1">
              {dashboardLinks.map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    className={({ isActive }) =>
                      [
                        'flex items-center justify-between rounded-xl px-3 py-2 transition-colors',
                        isActive
                          ? 'bg-ak-surface-2 text-ak-text-primary'
                          : 'text-ak-text-secondary hover:bg-ak-surface hover:text-ak-text-primary',
                      ].join(' ')
                    }
                  >
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-ak-text-secondary/70">
              Settings
            </p>
            <ul className="space-y-1">
              {settingsLinks.map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    className={({ isActive }) =>
                      [
                        'flex items-center justify-between rounded-xl px-3 py-2 transition-colors',
                        isActive
                          ? 'bg-ak-surface-2 text-ak-text-primary'
                          : 'text-ak-text-secondary hover:bg-ak-surface hover:text-ak-text-primary',
                      ].join(' ')
                    }
                  >
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <div className="mt-10">
          <Button
            variant="outline"
            className="w-full justify-center"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? 'Çıkış yapılıyor...' : 'Logout'}
          </Button>
        </div>
      </aside>

      <main className="flex-1">
        <div className="border-b border-ak-border bg-ak-surface px-6 py-4 lg:hidden">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-ak-text-primary">
                {workspaceLabel}
              </p>
              <p className="text-xs text-ak-text-secondary">{user?.email}</p>
            </div>
            <Button
              size="md"
              variant="outline"
              className="px-4 text-sm"
              onClick={handleLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? 'Çıkış...' : 'Logout'}
            </Button>
          </div>
        </div>

        <div className="px-4 py-8 sm:px-6 lg:px-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default DashboardShell;
