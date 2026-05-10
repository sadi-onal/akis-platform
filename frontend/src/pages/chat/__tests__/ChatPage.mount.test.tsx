import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ChatPage from '../ChatPage';

// ── Mocks ──────────────────────────────────────────

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Test' }, loading: false }),
}));

vi.mock('../../../theme/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    isDark: true,
    isLight: false,
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../../hooks/useProfileCompleteness', () => ({
  useProfileCompleteness: () => ({
    missingSteps: [],
    loading: false,
    hasGitHub: true,
    hasName: true,
    hasAiKey: true,
    isComplete: true,
    completedSteps: 3,
    totalSteps: 3,
  }),
}));

vi.mock('../../../hooks/usePipelineStream', () => ({
  usePipelineStream: () => ({ activities: [], currentStep: null, createdFiles: [], isConnected: false, progressByStage: {} }),
}));

// Mock workflowsApi — list returns empty, get rejects (no conversation selected)
vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockRejectedValue(new Error('Not found')),
    create: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    retry: vi.fn(),
    skipTrace: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    sendMessage: vi.fn(),
    getProtoFiles: vi.fn().mockResolvedValue(null),
    updateModel: vi.fn(),
    toggleTrace: vi.fn(),
  },
  mapPipelineToWorkflow: vi.fn(),
}));

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/logo.svg',
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../components/onboarding/GithubConnectGate', () => ({
  GithubConnectGate: () => null,
}));

vi.mock('../../../components/onboarding/githubConnectStorage', () => ({
  PENDING_GITHUB_IDEA_KEY: 'akis-pending-idea',
}));

vi.mock('../../../components/onboarding/AgentFeatureCard', () => ({
  AgentFeatureCard: ({ title }: { title: string }) => <div data-testid={`agent-${title}`}>{title}</div>,
}));

vi.mock('../../../components/chat/ChatSkeleton', () => ({
  ChatSkeleton: () => <div data-testid="chat-skeleton" />,
}));

// ── Helper ─────────────────────────────────────────

function renderChatPage(initialPath = '/chat') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/chat/*" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── Tests ──────────────────────────────────────────

describe('ChatPage — mount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    const { container } = renderChatPage();
    expect(container.firstElementChild).toBeTruthy();
  });

  it('renders application wrapper with correct aria-label', () => {
    renderChatPage();
    expect(screen.getByRole('application', { name: 'AKIS Chat' })).toBeInTheDocument();
  });

  it('renders the sidebar component', () => {
    renderChatPage();
    // The mobile hamburger menu button is always present
    expect(screen.getByLabelText('Menü')).toBeInTheDocument();
  });

  it('shows AKIS branding elements', () => {
    renderChatPage();
    // AKIS text and logo appear in both sidebar and mobile top bar
    const akisTexts = screen.getAllByText('AKIS');
    expect(akisTexts.length).toBeGreaterThanOrEqual(1);
    const akisLogos = screen.getAllByAltText('AKIS');
    expect(akisLogos.length).toBeGreaterThanOrEqual(1);
  });

  it('shows EmptyState when no conversation is selected', () => {
    renderChatPage('/chat');
    // EmptyState no-conversation variant renders agent feature cards
    expect(screen.getByTestId('agent-Scribe')).toBeInTheDocument();
    expect(screen.getByTestId('agent-Proto')).toBeInTheDocument();
    expect(screen.getByTestId('agent-Trace')).toBeInTheDocument();
  });

  it('shows new chat CTA button when no conversation selected', () => {
    renderChatPage('/chat');
    expect(screen.getByRole('button', { name: /chat\.emptyState\.newChat/i })).toBeInTheDocument();
  });

  it('memoized subtree mounts without runtime errors or warnings', () => {
    // React.memo-wrapped ChatPanel / ConversationSidebar / PreviewPanel should
    // render cleanly — no PropType warnings, key warnings, or act() warnings.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderChatPage('/chat');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ── F-01 regression: navigating between sohbets after Yeni Sohbet ──
//
// Bug: ChatPage held a global `lastMessagesKeyRef` cached as
// `<conversationId>:<convLen>:<lastTs>`. handleNewConversation reset every
// other ref but not this one. Clicking the original chat after Yeni Sohbet
// re-fetched the same payload, computed an identical key, and skipped
// setMessages — leaving the panel empty until F5.
//
// These tests load a real workflow, exercise the New-Sohbet → re-select flow,
// and assert messages render the second time.

describe('ChatPage — F-01 lastMessagesKeyRef reset on Yeni Sohbet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't implement scrollIntoView — ChatPanel uses it on the
    // bottom-of-list ref whenever messages change. Stub it so the auto-scroll
    // effect doesn't throw in the test environment.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  // Build a minimal Workflow shape that ChatPage will treat as a normal completed
  // conversation with one user message. Returned by workflowsApi.get() in tests.
  function buildWorkflow(id: string, content: string) {
    return {
      id,
      title: 'Test workflow',
      status: 'completed' as const,
      currentStage: 'completed' as const,
      traceEnabled: false,
      createdAt: '2026-05-09T12:00:00.000Z',
      updatedAt: '2026-05-09T12:00:01.000Z',
      stages: {
        scribe: { status: 'completed' as const },
        approve: { status: 'completed' as const },
        proto: { status: 'completed' as const },
        trace: { status: 'idle' as const },
      },
      conversation: [
        {
          role: 'user' as const,
          type: 'message' as const,
          content,
          timestamp: '2026-05-09T12:00:00.500Z',
        },
      ],
    };
  }

  async function getMockedWorkflowsApi() {
    const mod = await import('../../../services/api/workflows');
    return vi.mocked(mod.workflowsApi);
  }

  // Selector helpers — scoped to the sidebar so we don't collide with ChatHeader
  // (which also renders the workflow title at the top of the chat panel).
  function getSidebarRoot(container: HTMLElement) {
    const search = container.querySelector('[data-sidebar-search]');
    // Sidebar root is two levels above the search input (search container
    // wrapper → sidebar nav). Scope to the nearest aside-like container.
    const root = search?.closest('div.flex.h-dvh') ?? container;
    return root as HTMLElement;
  }

  it('re-renders messages after Yeni Sohbet → re-selecting the same conversation', async () => {
    const api = await getMockedWorkflowsApi();
    const wf = buildWorkflow('chat-A', 'merhaba dünya — F-01 fixture');
    api.list.mockResolvedValue([
      {
        id: 'chat-A',
        title: 'Sidebar Convo A',
        status: 'completed',
        currentStage: 'completed',
        traceEnabled: false,
        createdAt: '2026-05-09T12:00:00.000Z',
        updatedAt: '2026-05-09T12:00:01.000Z',
        stages: wf.stages,
      } as unknown as ReturnType<typeof buildWorkflow>,
    ]);
    api.get.mockResolvedValue(wf as unknown as ReturnType<typeof buildWorkflow>);

    const { container } = render(
      <MemoryRouter initialEntries={['/chat/chat-A']}>
        <Routes>
          <Route path="/chat/*" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Initial load: the user message renders.
    await waitFor(() => {
      expect(screen.getByText(/F-01 fixture/)).toBeInTheDocument();
    });
    expect(api.get).toHaveBeenCalledWith('chat-A');

    // Click Yeni Sohbet — drives handleNewConversation which (post-fix) resets
    // lastMessagesKeyRef. The chat surface flips to the pending-conversation view.
    // Multiple "Yeni Sohbet" buttons may exist (search-area button + collapsed
    // icon-only button); just click the first.
    const newSohbetBtns = await screen.findAllByText(/Yeni Sohbet/);
    const newSohbetBtn = newSohbetBtns[0].closest('button')!;
    await act(async () => {
      fireEvent.click(newSohbetBtn);
    });

    // Now click the original sohbet in the sidebar to re-select it.
    // ConversationItem renders the conversation title as a button.
    const sidebar = getSidebarRoot(container);
    const sidebarTitleSpans = await within(sidebar).findAllByText('Sidebar Convo A');
    const conversationButton = sidebarTitleSpans[0].closest('button')!;
    await act(async () => {
      fireEvent.click(conversationButton);
    });

    // Pre-fix: the cached key matched, setMessages was skipped, panel stayed empty.
    // Post-fix: the cache key was reset on Yeni Sohbet, so setMessages re-runs
    // and the original user message becomes visible again.
    await waitFor(() => {
      expect(screen.getByText(/F-01 fixture/)).toBeInTheDocument();
    });

    // Sanity: workflowsApi.get was called twice with the same id (initial load
    // + re-selection), confirming the second fetch actually happened and the
    // result was rendered rather than silently de-duped by the cache key.
    const callsForA = api.get.mock.calls.filter((c) => c[0] === 'chat-A');
    expect(callsForA.length).toBeGreaterThanOrEqual(2);
  });

  it('handleBack also clears the message-key cache (defense-in-depth)', async () => {
    // The Back button in ChatHeader routes through handleBack which navigates
    // to /chat. This test covers the same code path as Yeni Sohbet from a
    // different entry point — once we're back at /chat with no id, re-selecting
    // must still work. Without the F-01 fix the cache key collision blanks the
    // panel here too.
    const api = await getMockedWorkflowsApi();
    const wf = buildWorkflow('chat-B', 'F-01 back-button fixture');
    api.list.mockResolvedValue([
      {
        id: 'chat-B',
        title: 'Sidebar Convo B',
        status: 'completed',
        currentStage: 'completed',
        traceEnabled: false,
        createdAt: '2026-05-09T12:00:00.000Z',
        updatedAt: '2026-05-09T12:00:01.000Z',
        stages: wf.stages,
      } as unknown as ReturnType<typeof buildWorkflow>,
    ]);
    api.get.mockResolvedValue(wf as unknown as ReturnType<typeof buildWorkflow>);

    const { container } = render(
      <MemoryRouter initialEntries={['/chat/chat-B']}>
        <Routes>
          <Route path="/chat/*" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/back-button fixture/)).toBeInTheDocument();
    });

    // ChatHeader exposes a back button with aria-label="Geri". It calls
    // handleBack → navigate('/chat') → effect-driven cleanup with the
    // lastMessagesKeyRef reset added by F-01.
    const backBtn = await screen.findByLabelText('Geri');
    await act(async () => {
      fireEvent.click(backBtn);
    });

    const sidebar = getSidebarRoot(container);
    const sidebarTitleSpans = await within(sidebar).findAllByText('Sidebar Convo B');
    const conversationButton = sidebarTitleSpans[0].closest('button')!;
    await act(async () => {
      fireEvent.click(conversationButton);
    });

    await waitFor(() => {
      expect(screen.getByText(/back-button fixture/)).toBeInTheDocument();
    });
  });
});
