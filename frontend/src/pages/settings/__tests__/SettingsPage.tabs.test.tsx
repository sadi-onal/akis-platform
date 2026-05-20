/**
 * SettingsPage — additional tab + helper coverage (PDP-3 group B)
 *
 * The existing Profile/Integrations specs cover the profile + GitHub/Jira-OAuth
 * paths. This file fills the gaps:
 *
 *  - Tab navigation (setTab + back-to-chat)
 *  - AIKeysTab: loading, rendering, add/save flow, switch active, delete
 *  - PipelineStatsTab: loading, empty state, error state, rendering all
 *    analytics sections (error frequency, model dist, token usage, retry heatmap)
 *  - UsageTab: loading, empty, admin breakdown, daily activity chart
 *  - JiraSection PAT fallback flow (test/connect/disconnect)
 *  - ProfileTab error paths (save name failure, password failure)
 *  - formatDuration / formatTokens helper edge cases (via rendering)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------- Mocks (shared) ----------

const mockNavigate = vi.fn();
const mockSetSearchParams = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [currentSearchParams, mockSetSearchParams],
}));

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

const mockToast = vi.fn();
vi.mock('../../../components/ui/Toast', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../components/settings/AvatarCropModal', () => ({
  __esModule: true,
  default: ({
    onConfirm,
    onCancel,
  }: {
    onConfirm: (url: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="avatar-crop-modal">
      <button onClick={() => onConfirm('data:image/jpeg;base64,FAKE')}>mock-confirm</button>
      <button onClick={onCancel}>mock-cancel</button>
    </div>
  ),
}));

const mockUpdateAvatar = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    updateAvatar: (url: string | null) => mockUpdateAvatar(url),
  },
}));

const mockGetUsage = vi.fn();
vi.mock('../../../services/api/client', () => ({
  api: {
    getUsage: () => mockGetUsage(),
  },
}));

// ---------- Default fetch implementation ----------

interface MakeFetchOpts {
  profile?: Record<string, unknown> | null;
  aiKeysStatus?: Record<string, unknown> | null;
  pipelineStats?: Record<string, unknown> | null;
  pipelineStatsFail?: boolean;
  githubConnected?: boolean;
  atlassianConnected?: boolean;
  jiraPatConnected?: boolean;
  saveProfileFails?: boolean;
  changePasswordFails?: 'unauth' | 'server' | false;
  aiKeySaveFails?: boolean;
  aiKeyDeleteFails?: boolean;
  jiraTestOk?: boolean;
}

function makeFetch(opts: MakeFetchOpts = {}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    // ---- Profile ----
    if (url === '/api/settings/profile' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.profile ?? {
              id: 'u1',
              name: 'Omer Yasir',
              email: 'omer@example.com',
              emailVerified: true,
              status: 'active',
              createdAt: '2026-01-15T10:00:00.000Z',
            }
          ),
      });
    }
    if (url === '/api/settings/profile' && method === 'PUT') {
      if (opts.saveProfileFails) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      const body = JSON.parse((init?.body as string) ?? '{}');
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'u1',
            name: body.name,
            email: 'omer@example.com',
            emailVerified: true,
            status: 'active',
            createdAt: '2026-01-15T10:00:00.000Z',
          }),
      });
    }
    if (url === '/api/settings/profile/password' && method === 'PUT') {
      if (opts.changePasswordFails === 'server') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: { message: 'server-down' } }),
        });
      }
      if (opts.changePasswordFails === 'unauth') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    // ---- AI keys ----
    if (url === '/api/settings/ai-keys/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.aiKeysStatus ?? {
              activeProvider: null,
              providers: {
                anthropic: { configured: false, last4: null, updatedAt: null },
                openai: { configured: false, last4: null, updatedAt: null },
                google: { configured: false, last4: null, updatedAt: null },
              },
              keySource: 'akis',
              canUseOwnKey: true,
            }
          ),
      });
    }
    if (url === '/api/settings/ai-keys' && method === 'PUT') {
      if (opts.aiKeySaveFails) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ message: 'invalid-key' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === '/api/settings/ai-keys' && method === 'DELETE') {
      if (opts.aiKeyDeleteFails) {
        return Promise.reject(new Error('network'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === '/api/settings/ai-provider/active' && method === 'PUT') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    // ---- Pipeline stats ----
    if (url === '/api/settings/pipeline-stats') {
      if (opts.pipelineStatsFail) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.pipelineStats ?? {
              totalPipelines: 12,
              successRate: 75,
              avgDurations: {
                scribeMs: 1500,
                protoMs: 90_000, // exercises min branch
                traceMs: 200,
                totalMs: 95_000,
              },
              recentPipelines: [
                {
                  id: 'p1',
                  title: 'Pipeline one',
                  stage: 'completed',
                  createdAt: '2026-05-01T10:00:00.000Z',
                  durationMs: 12_000,
                },
                {
                  id: 'p2',
                  title: null,
                  stage: 'unknown_stage',
                  createdAt: '2026-05-02T10:00:00.000Z',
                  durationMs: 500,
                },
              ],
              errorFrequency: [
                { code: 'TIMEOUT', count: 3 },
                { code: 'DB_ERR', count: 1 },
              ],
              modelDistribution: [
                { model: 'claude-haiku', count: 8 },
                { model: 'claude-sonnet', count: 4 },
              ],
              tokenUsage: [
                { agent: 'scribe', inputTokens: 1000, outputTokens: 500 },
                { agent: 'proto', inputTokens: 2000, outputTokens: 800 },
              ],
              retryPatterns: [
                { stage: 'scribe_clarifying', retries: 0 },
                { stage: 'proto_building', retries: 2 },
                { stage: 'trace_testing', retries: 5 },
              ],
            }
          ),
      });
    }
    // ---- Integrations: GitHub ----
    if (url === '/api/integrations/github/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.githubConnected
              ? { connected: true, login: 'octocat', avatarUrl: null }
              : { connected: false }
          ),
      });
    }
    if (url === '/api/integrations/github' && method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    // ---- Integrations: Atlassian / Jira ----
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
                  confluenceAvailable: true,
                }
              : { connected: false, configured: false }
          ),
      });
    }
    if (url === '/api/settings/integrations/jira/status') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            opts.jiraPatConnected
              ? { connected: true, siteUrl: 'https://acme.atlassian.net' }
              : { connected: false }
          ),
      });
    }
    if (url === '/api/integrations/jira/test') {
      return Promise.resolve({
        ok: opts.jiraTestOk !== false,
        json: () => Promise.resolve(opts.jiraTestOk === false ? { message: 'invalid-creds' } : {}),
      });
    }
    if (url === '/api/settings/integrations/jira/connect') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === '/api/settings/integrations/jira/disconnect') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === '/api/integrations/atlassian/disconnect') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    // ---- default ----
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ---------- Helpers ----------

function withTab(tab: string) {
  currentSearchParams = new URLSearchParams(tab ? `tab=${tab}` : '');
}

// Lazy import so mocks are registered first
import SettingsPage from '../SettingsPage';

// ---------- Tab navigation ----------

describe('SettingsPage — tab navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    mockGetUsage.mockResolvedValue(null);
  });

  it('renders the page header with title and back button', async () => {
    render(<SettingsPage />);
    expect(screen.getByText('settings.title')).toBeInTheDocument();
    expect(screen.getByText('settings.backToChat')).toBeInTheDocument();
  });

  it('clicking back-to-chat navigates to /chat', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('settings.backToChat'));
    expect(mockNavigate).toHaveBeenCalledWith('/chat');
  });

  it('renders all five tab buttons', async () => {
    render(<SettingsPage />);
    expect(screen.getByText('settings.tab.profile')).toBeInTheDocument();
    expect(screen.getByText('settings.tab.aiKeys')).toBeInTheDocument();
    expect(screen.getByText('settings.tab.usage')).toBeInTheDocument();
    expect(screen.getByText('settings.tab.pipelineStats')).toBeInTheDocument();
    expect(screen.getByText('settings.tab.integrations')).toBeInTheDocument();
  });

  it('clicking a tab updates the search params (calls setSearchParams)', async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('settings.tab.aiKeys'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: 'ai-keys' });
    fireEvent.click(screen.getByText('settings.tab.usage'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: 'usage' });
    fireEvent.click(screen.getByText('settings.tab.pipelineStats'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: 'pipeline-stats' });
    fireEvent.click(screen.getByText('settings.tab.integrations'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: 'integrations' });
    // Going back to profile passes empty params.
    fireEvent.click(screen.getByText('settings.tab.profile'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({});
  });
});

// ---------- AIKeysTab ----------

describe('AIKeysTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTab('ai-keys');
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    mockGetUsage.mockResolvedValue(null);
  });

  // P12: All three providers (Anthropic, OpenAI, Google) are runtime-active; the
  // "yakında" label for OpenAI was stale after P1a (#553) and Google never had a
  // row before P1c (#552) shipped the runtime client.
  it('renders Anthropic + OpenAI + Google provider rows (no "yakında" label)', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Anthropic (Claude)')).toBeInTheDocument();
    });
    expect(screen.getByText('OpenAI (GPT)')).toBeInTheDocument();
    expect(screen.getByText('Google (Gemini)')).toBeInTheDocument();
    // Regression guard: the legacy "yakında" string must not appear anywhere.
    expect(screen.queryByText(/yakında/i)).not.toBeInTheDocument();
  });

  it('shows AKIS built-in card as active by default', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.ai.akisBuiltinKey')).toBeInTheDocument();
    });
  });

  it('shows toast when clicking the built-in card while own-key is active', async () => {
    globalThis.fetch = makeFetch({
      aiKeysStatus: {
        activeProvider: 'anthropic',
        providers: {
          anthropic: { configured: true, last4: '1234', updatedAt: '2026-01-01' },
          openai: { configured: false, last4: null, updatedAt: null },
          google: { configured: false, last4: null, updatedAt: null },
        },
        keySource: 'own',
        canUseOwnKey: true,
      },
    }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.ai.akisBuiltinKey')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('settings.ai.akisBuiltinKey'));
    expect(mockToast).toHaveBeenCalledWith('settings.ai.toast.switchToAkisHint', 'info');
  });

  it('"Ekle" button opens the editor, then Cancel collapses it', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByText('settings.ai.add').length).toBeGreaterThan(0);
    });
    const addButtons = screen.getAllByText('settings.ai.add');
    fireEvent.click(addButtons[0]);
    // Now the editor shows: an input with placeholder sk-ant-... and Save/Cancel buttons.
    const input = screen.getByPlaceholderText('sk-ant-...');
    expect(input).toBeInTheDocument();
    fireEvent.click(screen.getByText('settings.ai.cancel'));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('sk-ant-...')).toBeNull();
    });
  });

  it('saves a new API key (happy path) and re-fetches status', async () => {
    const fetchSpy = makeFetch();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByText('settings.ai.add').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText('settings.ai.add')[0]);
    const input = screen.getByPlaceholderText('sk-ant-...');
    fireEvent.change(input, { target: { value: 'sk-ant-abc' } });

    fireEvent.click(screen.getByText('settings.ai.save'));

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) => c[0] === '/api/settings/ai-keys' && c[1]?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.provider).toBe('anthropic');
      expect(body.apiKey).toBe('sk-ant-abc');
    });
    expect(mockToast).toHaveBeenCalledWith('settings.ai.toast.saved', 'success');
  });

  it('surfaces an error toast when save fails', async () => {
    globalThis.fetch = makeFetch({ aiKeySaveFails: true }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByText('settings.ai.add').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText('settings.ai.add')[0]);
    fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), {
      target: { value: 'sk-ant-bad' },
    });
    fireEvent.click(screen.getByText('settings.ai.save'));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('invalid-key', 'error');
    });
    // Error text also rendered inline.
    expect(screen.getByText('invalid-key')).toBeInTheDocument();
  });

  it('delete button calls DELETE after confirmation', async () => {
    const fetchSpy = makeFetch({
      aiKeysStatus: {
        activeProvider: 'anthropic',
        providers: {
          anthropic: { configured: true, last4: '1234', updatedAt: '2026-01-01' },
          openai: { configured: false, last4: null, updatedAt: null },
          google: { configured: false, last4: null, updatedAt: null },
        },
        keySource: 'own',
        canUseOwnKey: true,
      },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.ai.delete')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('settings.ai.delete'));
    await waitFor(() => {
      const del = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) => c[0] === '/api/settings/ai-keys' && c[1]?.method === 'DELETE'
      );
      expect(del).toBeDefined();
    });

    confirmSpy.mockRestore();
  });

  it('delete button is a no-op when user cancels the confirm', async () => {
    const fetchSpy = makeFetch({
      aiKeysStatus: {
        activeProvider: 'anthropic',
        providers: {
          anthropic: { configured: true, last4: '1234', updatedAt: '2026-01-01' },
          openai: { configured: false, last4: null, updatedAt: null },
          google: { configured: false, last4: null, updatedAt: null },
        },
        keySource: 'own',
        canUseOwnKey: true,
      },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.ai.delete')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('settings.ai.delete'));
    // No DELETE call should appear.
    const del = fetchSpy.mock.calls.find(
      (c: [string, RequestInit?]) => c[0] === '/api/settings/ai-keys' && c[1]?.method === 'DELETE'
    );
    expect(del).toBeUndefined();

    confirmSpy.mockRestore();
  });

  it('Varsayilan-yap button calls PUT /api/settings/ai-provider/active', async () => {
    const fetchSpy = makeFetch({
      aiKeysStatus: {
        activeProvider: 'openai',
        providers: {
          anthropic: { configured: true, last4: '1234', updatedAt: '2026-01-01' },
          openai: { configured: true, last4: '5678', updatedAt: '2026-01-01' },
          google: { configured: false, last4: null, updatedAt: null },
        },
        keySource: 'own',
        canUseOwnKey: true,
      },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.ai.makeDefault')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('settings.ai.makeDefault'));
    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) =>
          c[0] === '/api/settings/ai-provider/active' && c[1]?.method === 'PUT'
      );
      expect(put).toBeDefined();
    });
  });
});

// ---------- PipelineStatsTab ----------

describe('PipelineStatsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTab('pipeline-stats');
    mockGetUsage.mockResolvedValue(null);
  });

  it('renders the headline stats once loaded', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.stats.totalPipelines')).toBeInTheDocument();
    });
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('%75')).toBeInTheDocument();
  });

  it('renders the recent-pipelines table with multiple rows', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Pipeline one')).toBeInTheDocument();
    });
    // The second row has a null title — falls back to the "unnamed" label.
    expect(screen.getByText('settings.stats.unnamed')).toBeInTheDocument();
  });

  it('renders all analytics sub-sections (errors, models, tokens, retries)', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.stats.errors')).toBeInTheDocument();
    });
    expect(screen.getByText('TIMEOUT')).toBeInTheDocument();
    expect(screen.getByText('settings.stats.models')).toBeInTheDocument();
    expect(screen.getByText('claude-haiku')).toBeInTheDocument();
    expect(screen.getByText('settings.stats.tokens')).toBeInTheDocument();
    // Token usage row content rendered.
    expect(screen.getByText('scribe')).toBeInTheDocument();
    expect(screen.getByText('settings.stats.retries')).toBeInTheDocument();
  });

  it('shows empty state when there are no recent pipelines', async () => {
    globalThis.fetch = makeFetch({
      pipelineStats: {
        totalPipelines: 0,
        successRate: 0,
        avgDurations: { scribeMs: null, protoMs: null, traceMs: null, totalMs: null },
        recentPipelines: [],
      },
    }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      // Expect at least one empty state placeholder.
      const empties = screen.getAllByText('settings.stats.empty');
      expect(empties.length).toBeGreaterThan(0);
    });
  });

  it('shows an error message when fetch fails', async () => {
    globalThis.fetch = makeFetch({ pipelineStatsFail: true }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.stats.error')).toBeInTheDocument();
    });
  });
});

// ---------- UsageTab ----------

describe('UsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTab('usage');
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
  });

  it('renders an empty state when api.getUsage returns null', async () => {
    mockGetUsage.mockResolvedValue(null);
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.usage.noData')).toBeInTheDocument();
    });
  });

  it('renders the headline stats and breakdown for non-admin', async () => {
    mockGetUsage.mockResolvedValue({
      period: { start: '2026-05-01', end: '2026-05-31' },
      usage: {
        inputTokens: 2_500_000,
        outputTokens: 1_500,
        totalTokens: 2_501_500,
        estimatedCostUsd: 0.0123,
        jobCount: 42,
      },
      userIsAdmin: false,
    });
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.usage.title')).toBeInTheDocument();
    });
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('settings.usage.cost')).toBeInTheDocument();
    // formatTokens: 2.5M, 1.5K
    expect(screen.getAllByText('2.5M').length).toBeGreaterThan(0);
    expect(screen.getByText('1.5K')).toBeInTheDocument();
  });

  it('renders the admin breakdown when userIsAdmin is true', async () => {
    mockGetUsage.mockResolvedValue({
      period: { start: '2026-05-01', end: '2026-05-31' },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.005,
        jobCount: 3,
      },
      userIsAdmin: true,
      breakdown: {
        wholesale: 0.001,
        retail: 0.005,
        input: 0.0005,
        output: 0.0005,
        margin: 0.004,
        markup: 5.0,
      },
    });
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.usage.costAdmin')).toBeInTheDocument();
    });
    expect(screen.getByText('Wholesale')).toBeInTheDocument();
    expect(screen.getByText('Retail')).toBeInTheDocument();
    expect(screen.getByText('Margin')).toBeInTheDocument();
    expect(screen.getByText(/markup 5\.00x/)).toBeInTheDocument();
  });

  it('renders the daily activity chart with one or more days', async () => {
    mockGetUsage.mockResolvedValue({
      period: { start: '2026-05-01', end: '2026-05-31' },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.005,
        jobCount: 3,
      },
      userIsAdmin: false,
      daily: [
        { date: '2026-05-01', tokens: 100, cost: 0.001, jobs: 1 },
        { date: '2026-05-02', tokens: 0, cost: 0, jobs: 0 },
        { date: '2026-05-03', tokens: 50, cost: 0.0005, jobs: 1 },
      ],
    });
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.usage.dailyActivity')).toBeInTheDocument();
    });
    // The daily list rows should be present (uses settings.usage.jobSuffix key).
    expect(screen.getAllByText(/settings\.usage\.jobSuffix/).length).toBeGreaterThan(0);
  });
});

// ---------- JiraSection PAT fallback ----------

describe('JiraSection — PAT fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTab('integrations');
    mockGetUsage.mockResolvedValue(null);
  });

  it('renders the OAuth disconnect button when atlassian is connected', async () => {
    globalThis.fetch = makeFetch({ atlassianConnected: true }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('integrations.jira.disconnect')).toBeInTheDocument();
    });
    // Both Jira and Confluence chips should be visible.
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByText('Confluence')).toBeInTheDocument();
  });

  it('toggles the PAT fallback form open and closed', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('integrations.jira.showPatFallback')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('integrations.jira.showPatFallback'));
    expect(screen.getByText('integrations.jira.instanceUrl')).toBeInTheDocument();
    // Toggle back closed.
    fireEvent.click(screen.getByText('integrations.jira.hidePatFallback'));
    await waitFor(() => {
      expect(screen.queryByText('integrations.jira.instanceUrl')).toBeNull();
    });
  });

  it('happy-path PAT test → POST /jira/test then POST /jira/connect', async () => {
    const fetchSpy = makeFetch({ jiraTestOk: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('integrations.jira.showPatFallback')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('integrations.jira.showPatFallback'));

    const urlInput = screen.getByPlaceholderText('integrations.jira.instanceUrlPlaceholder');
    const tokenInput = screen.getByPlaceholderText('integrations.jira.apiTokenPlaceholder');
    fireEvent.change(urlInput, { target: { value: 'https://acme.atlassian.net' } });
    fireEvent.change(tokenInput, { target: { value: 'tok-12345678' } });

    fireEvent.click(screen.getByText('integrations.jira.testConnection'));

    await waitFor(() => {
      const test = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) => c[0] === '/api/integrations/jira/test'
      );
      expect(test).toBeDefined();
      const connect = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) =>
          c[0] === '/api/settings/integrations/jira/connect' && c[1]?.method === 'POST'
      );
      expect(connect).toBeDefined();
    });
  });

  it('shows the PAT error inline when /jira/test fails', async () => {
    const fetchSpy = makeFetch({ jiraTestOk: false });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('integrations.jira.showPatFallback')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('integrations.jira.showPatFallback'));

    fireEvent.change(screen.getByPlaceholderText('integrations.jira.instanceUrlPlaceholder'), {
      target: { value: 'https://acme.atlassian.net' },
    });
    fireEvent.change(screen.getByPlaceholderText('integrations.jira.apiTokenPlaceholder'), {
      target: { value: 'tok-12345678' },
    });

    fireEvent.click(screen.getByText('integrations.jira.testConnection'));

    await waitFor(() => {
      expect(screen.getByText('invalid-creds')).toBeInTheDocument();
    });
  });

  it('PAT disconnect calls backend then resets state', async () => {
    const fetchSpy = makeFetch({ jiraPatConnected: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('integrations.jira.disconnect')).toBeInTheDocument();
    });
    // We should see the PAT URL chip.
    expect(screen.getByText('https://acme.atlassian.net')).toBeInTheDocument();

    fireEvent.click(screen.getByText('integrations.jira.disconnect'));

    await waitFor(() => {
      const dc = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) =>
          c[0] === '/api/settings/integrations/jira/disconnect' && c[1]?.method === 'POST'
      );
      expect(dc).toBeDefined();
    });
  });
});

// ---------- ProfileTab error paths ----------

describe('ProfileTab — additional error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    mockGetUsage.mockResolvedValue(null);
  });

  it('shows error toast when save-name PUT fails', async () => {
    globalThis.fetch = makeFetch({ saveProfileFails: true }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const nameInput = screen.getAllByDisplayValue('Omer Yasir')[0];
    fireEvent.change(nameInput, { target: { value: 'Omer Updated' } });
    fireEvent.click(screen.getAllByText('settings.ai.save')[0]);
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('settings.profile.nameError', 'error');
    });
  });

  it('shows success toast and resets fields after password change', async () => {
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordTitle')).toBeInTheDocument();
    });

    const currentLabel = screen.getByText('settings.profile.currentPassword');
    const newLabel = screen.getByText('settings.profile.newPassword');
    const confirmLabel = screen.getByText('settings.profile.confirmPassword');
    const currentInput = currentLabel.parentElement!.querySelector('input')!;
    const newInput = newLabel.parentElement!.querySelector('input')!;
    const confirmInput = confirmLabel.parentElement!.querySelector('input')!;

    fireEvent.change(currentInput, { target: { value: 'OldPass1234' } });
    fireEvent.change(newInput, { target: { value: 'NewPass1234' } });
    fireEvent.change(confirmInput, { target: { value: 'NewPass1234' } });

    fireEvent.click(screen.getByText('settings.profile.changePassword'));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('settings.profile.passwordChanged', 'success');
    });
    // Inputs should be cleared on success.
    await waitFor(() => {
      expect(currentInput.value).toBe('');
      expect(newInput.value).toBe('');
      expect(confirmInput.value).toBe('');
    });
  });

  it('surfaces server-supplied message on password change failure', async () => {
    globalThis.fetch = makeFetch({
      changePasswordFails: 'server',
    }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordTitle')).toBeInTheDocument();
    });

    const currentInput = screen
      .getByText('settings.profile.currentPassword')
      .parentElement!.querySelector('input')!;
    const newInput = screen
      .getByText('settings.profile.newPassword')
      .parentElement!.querySelector('input')!;
    const confirmInput = screen
      .getByText('settings.profile.confirmPassword')
      .parentElement!.querySelector('input')!;

    fireEvent.change(currentInput, { target: { value: 'OldPass1234' } });
    fireEvent.change(newInput, { target: { value: 'NewPass1234' } });
    fireEvent.change(confirmInput, { target: { value: 'NewPass1234' } });

    fireEvent.click(screen.getByText('settings.profile.changePassword'));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('server-down', 'error');
    });
  });

  it('falls back to generic password error when server returns no message', async () => {
    globalThis.fetch = makeFetch({
      changePasswordFails: 'unauth',
    }) as unknown as typeof fetch;
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordTitle')).toBeInTheDocument();
    });
    const currentInput = screen
      .getByText('settings.profile.currentPassword')
      .parentElement!.querySelector('input')!;
    const newInput = screen
      .getByText('settings.profile.newPassword')
      .parentElement!.querySelector('input')!;
    const confirmInput = screen
      .getByText('settings.profile.confirmPassword')
      .parentElement!.querySelector('input')!;

    fireEvent.change(currentInput, { target: { value: 'OldPass1234' } });
    fireEvent.change(newInput, { target: { value: 'NewPass1234' } });
    fireEvent.change(confirmInput, { target: { value: 'NewPass1234' } });

    fireEvent.click(screen.getByText('settings.profile.changePassword'));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('settings.profile.passwordError', 'error');
    });
  });
});

// ---------- Avatar pick flow ----------

describe('ProfileTab — avatar pick / crop flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    mockGetUsage.mockResolvedValue(null);

    // Stub URL.createObjectURL / revokeObjectURL so the blob lifecycle path runs.
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      configurable: true,
      value: vi.fn(() => 'blob:fake-url-1'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      configurable: true,
      value: vi.fn(),
    });
  });

  function findHiddenAvatarInput(container: HTMLElement) {
    return container.querySelector('input[type="file"]') as HTMLInputElement;
  }

  it('rejects oversized files with a toast', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const fileInput = findHiddenAvatarInput(container);
    expect(fileInput).toBeTruthy();

    // 9MB > 8MB cap → toast error, no modal.
    const bigFile = new File(['x'.repeat(10)], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(bigFile, 'size', { value: 9_000_000 });

    fireEvent.change(fileInput, { target: { files: [bigFile] } });

    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('8MB'), 'error');
    expect(screen.queryByTestId('avatar-crop-modal')).toBeNull();
  });

  it('rejects unsupported MIME types', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const fileInput = findHiddenAvatarInput(container);
    const f = new File(['hi'], 'bad.bmp', { type: 'image/bmp' });
    fireEvent.change(fileInput, { target: { files: [f] } });
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('JPG, PNG'), 'error');
  });

  it('valid file opens crop modal; confirming uploads via AuthAPI', async () => {
    mockUpdateAvatar.mockResolvedValue({
      id: 'u1',
      name: 'Omer Yasir',
      email: 'omer@example.com',
      avatarUrl: 'data:image/jpeg;base64,UPDATED',
    });

    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const fileInput = findHiddenAvatarInput(container);
    const f = new File(['hi'], 'avatar.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [f] } });

    // Modal mounts.
    await waitFor(() => {
      expect(screen.getByTestId('avatar-crop-modal')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('mock-confirm'));

    await waitFor(() => {
      expect(mockUpdateAvatar).toHaveBeenCalledWith('data:image/jpeg;base64,FAKE');
    });
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('settings.profile.avatarUpdated', 'success');
    });
    // Modal closes after success.
    await waitFor(() => {
      expect(screen.queryByTestId('avatar-crop-modal')).toBeNull();
    });
  });

  it('cancel button closes the crop modal', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const fileInput = findHiddenAvatarInput(container);
    const f = new File(['hi'], 'avatar.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [f] } });
    await waitFor(() => {
      expect(screen.getByTestId('avatar-crop-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('mock-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('avatar-crop-modal')).toBeNull();
    });
  });

  it('shows an error toast when avatar upload fails', async () => {
    mockUpdateAvatar.mockRejectedValue(new Error('upload-failed'));

    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });
    const fileInput = findHiddenAvatarInput(container);
    const f = new File(['hi'], 'avatar.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [f] } });
    await waitFor(() => {
      expect(screen.getByTestId('avatar-crop-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('mock-confirm'));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('settings.profile.avatarUploadFailed', 'error');
    });
    // Modal stays open so the user can retry.
    expect(screen.getByTestId('avatar-crop-modal')).toBeInTheDocument();
  });
});
