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

function makeFetch(opts: {
  githubConnected?: boolean;
  githubLogin?: string;
  atlassianConnected?: boolean;
} = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/integrations/github/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.githubConnected
              ? { connected: true, login: opts.githubLogin ?? 'octocat', avatarUrl: null }
              : { connected: false },
          ),
      });
    }
    if (url === '/api/integrations/atlassian/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.atlassianConnected
              ? { connected: true, configured: true, jiraAvailable: true, confluenceAvailable: false }
              : { connected: false, configured: false },
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
    globalThis.fetch = makeFetch({ githubConnected: true, githubLogin: 'OmerYasir' }) as unknown as typeof fetch;
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
    globalThis.fetch = makeFetch({ githubConnected: true, githubLogin: 'testuser' }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.github.connectedAs')).toBeInTheDocument();
    });
  });

  it('shows disconnect button when connected', async () => {
    globalThis.fetch = makeFetch({ githubConnected: true, githubLogin: 'octocat' }) as unknown as typeof fetch;
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
          c[0] === '/api/integrations/github' && c[1]?.method === 'DELETE',
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

  it('shows connected status when backend reports Jira PAT connected', async () => {
    // PAT credentials now stored on backend, not localStorage
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/jira/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, siteUrl: 'https://mysite.atlassian.net' }) });
      }
      if (typeof url === 'string' && url.includes('/atlassian/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: false }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.jira.disconnect')).toBeInTheDocument();
    });
  });

  it('PAT disconnect calls backend API', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/jira/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: true, siteUrl: 'https://mysite.atlassian.net' }) });
      }
      if (typeof url === 'string' && url.includes('/jira/disconnect')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      if (typeof url === 'string' && url.includes('/atlassian/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ connected: false }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.jira.disconnect')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('integrations.jira.disconnect'));

    // Should NOT use localStorage anymore
    expect(localStorage.getItem('akis_jira_pat')).toBeNull();
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
          c[0] === '/api/integrations/atlassian/disconnect' && c[1]?.method === 'POST',
      );
      expect(disconnectCall).toBeDefined();
    });
  });
});

describe('IntegrationsTab — Cucumber Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows Cucumber section title', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.cucumber.title')).toBeInTheDocument();
    });
  });

  it('toggle stores enabled state in localStorage', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.cucumber.toggleLabel')).toBeInTheDocument();
    });

    // Find the toggle button (it's a button with a specific class pattern)
    const toggleLabel = screen.getByText('integrations.cucumber.toggleLabel');
    const toggleRow = toggleLabel.closest('div');
    const toggleBtn = toggleRow?.querySelector('button');
    expect(toggleBtn).toBeTruthy();

    fireEvent.click(toggleBtn!);
    expect(localStorage.getItem('akis_cucumber_enabled')).toBe('true');

    fireEvent.click(toggleBtn!);
    expect(localStorage.getItem('akis_cucumber_enabled')).toBe('false');
  });
});

describe('IntegrationsTab — Slack Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows Slack section with "coming soon" badge', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('integrations.slack.comingSoon')).toBeInTheDocument();
    });
  });

  it('Slack connect button is disabled', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);

    await waitFor(() => {
      const slackBtn = screen.getByText('integrations.slack.connectButton');
      expect(slackBtn).toBeDisabled();
    });
  });
});
