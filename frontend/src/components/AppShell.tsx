import { Outlet, Link } from 'react-router-dom';
import { LOGO_MARK_SVG } from '../theme/brand';
import { useAuth } from '../contexts/AuthContext';
import { POST_AUTH_PATH } from '../app/routes';

/**
 * AppShell — chrome for the public-facing routes (auth pages, legal).
 *
 * Reads AuthContext so signed-in users get a "Sohbete Dön" link to /chat
 * instead of being told to log in to the account they already have.
 */
export default function AppShell() {
  const { user, loading } = useAuth();
  const isAuthenticated = !loading && !!user;

  return (
    <div className="relative min-h-screen flex flex-col bg-ak-bg text-ak-text-primary">
      <header className="sticky top-0 z-40 border-b border-ak-border bg-ak-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 text-ak-text-primary hover:opacity-80 transition-opacity">
            <img src={LOGO_MARK_SVG} alt="AKIS" className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-tight">AKIS</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/docs" className="text-ak-text-secondary hover:text-ak-text-primary transition-colors">Docs</Link>
            {isAuthenticated ? (
              <Link to={POST_AUTH_PATH} className="text-ak-text-secondary hover:text-ak-text-primary transition-colors">
                Sohbete Dön
              </Link>
            ) : (
              <Link to="/login" className="text-ak-text-secondary hover:text-ak-text-primary transition-colors">
                Giriş Yap
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-ak-border px-4 py-6 text-center">
        <p className="text-xs text-ak-text-secondary">
          AKIS Platform — FSMVÜ Bitirme Projesi &copy; 2026
        </p>
        <p className="mt-1 text-xs text-ak-text-secondary/60">
          Ömer Yasir Önal — Dr. Öğr. Üyesi Nazlı Doğan
        </p>
      </footer>
    </div>
  );
}
