import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  useProfileCompleteness: () => ({ missingSteps: [], loading: false }),
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
  },
  mapPipelineToWorkflow: vi.fn(),
}));

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/logo.svg',
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../components/onboarding/ProfileSetupBanner', () => ({
  ProfileSetupBanner: () => null,
}));

vi.mock('../../../components/onboarding/ProfileSetupWizard', () => ({
  ProfileSetupWizard: () => null,
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
