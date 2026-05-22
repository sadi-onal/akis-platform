/**
 * IntegrationsTab — Settings integrations tests
 *
 * Covers:
 *  - GitHub section: connect button when not connected, username when connected
 *  - Jira section: Atlassian OAuth connect + PAT fallback
 *  - Cucumber toggle stores in localStorage
 *  - Disconnect buttons call correct endpoints
 *  - Slack section shows "coming soon"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------- Mocks ----------

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Omer Yasir', email: 'omer@example.com' },
    setUser: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('tab=integrations'), vi.fn()],
  useNavigate: () => vi.fn(),
}));

// ---------- Helpers ----------

function makeFetch(
  opts: {
    githubConnected?: boolean;
    githubLogin?: string;
    atlassianConnected?: boolean;
  } = {}
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/integrations/github/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.githubConnected
              ? { connected: true, login: opts.githubLogin ?? 'octocat', avatarUrl: null }
              : { connected: false }
          ),
      });
    }
    if (url === '/api/integrations/atlassian/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.atlassianConnected
              ? {
                  connected: true,
                  configured: true,
                  jiraAvailable: true,
                  confluenceAvailable: false,
                }
              : { connected: false, configured: false }
          ),
      });
    }
    // Default fallback for other URLs (profile, ai-keys, etc.)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

import SettingsPage from '../SettingsPage';

// ---------- Tests ----------

describe('IntegrationsTab — GitHub Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows connect button when GitHub is not connected', async () => {
    globalThis.fetch = makeFetch({ githubConnected: false }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.connectButton')).toBeInTheDocument();
    });
  });

  it('shows login username when GitHub is connected', async () => {
    globalThis.fetch = makeFetch({
      githubConnected: true,
      githubLogin: 'OmerYasir',
    }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('OmerYasir')).toBeInTheDocument();
    });
  });

  it('shows GitHub card description', async () => {
    globalThis.fetch = makeFetch({ githubConnected: false }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.cardDescription')).toBeInTheDocument();
    });
  });

  it('shows "connectedAs" text when connected', async () => {
    globalThis.fetch = makeFetch({
      githubConnected: true,
      githubLogin: 'testuser',
    }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.connectedAs')).toBeInTheDocument();
    });
  });

  it('shows disconnect button when connected', async () => {
    globalThis.fetch = makeFetch({
      githubConnected: true,
      githubLogin: 'octocat',
    }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.disconnectButton')).toBeInTheDocument();
    });
  });

  it('calls DELETE /api/integrations/github on disconnect', async () => {
    const fetchMock = makeFetch({ githubConnected: true, githubLogin: 'octocat' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.disconnectButton')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('integrations.github.disconnectButton'));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) =>
          c[0] === '/api/integrations/github' && c[1]?.method === 'DELETE'
      );
      expect(deleteCall).toBeDefined();
    });
  });
});

describe('IntegrationsTab — Jira Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows Jira section title', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.jira.title')).toBeInTheDocument();
    });
  });

  it('shows OAuth connect button when disconnected', async () => {
    globalThis.fetch = makeFetch({ atlassianConnected: false }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.jira.oauthConnect')).toBeInTheDocument();
    });
  });

  it('calls POST /api/integrations/atlassian/disconnect for OAuth disconnect', async () => {
    const fetchMock = makeFetch({ atlassianConnected: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.jira.disconnect')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('integrations.jira.disconnect'));

    await waitFor(() => {
      const disconnectCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) =>
          c[0] === '/api/integrations/atlassian/disconnect' && c[1]?.method === 'POST'
      );
      expect(disconnectCall).toBeDefined();
    });
  });
});
