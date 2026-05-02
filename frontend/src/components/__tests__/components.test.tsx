import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ─── Mocks shared across suites ──────────────────────────────────────
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Test' }, loading: false }),
}));

vi.mock('../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.emptyState.greeting': 'Merhaba! Ben',
        'chat.emptyState.brandName': 'AKIS',
        'chat.emptyState.subtitle': 'Fikrini anlat, gerisini ben halledeyim.',
        'chat.emptyState.heroSubtitle': 'Fikrinizi yazin, agent pipeline baslat.',
        'chat.emptyState.newChat': 'Yeni Sohbet Baslat',
        'chat.emptyState.scribeDesc': 'Scribe desc',
        'chat.emptyState.protoDesc': 'Proto desc',
        'chat.emptyState.traceDesc': 'Trace desc',
      };
      return map[key] ?? key;
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    setLocale: vi.fn(),
  }),
}));

vi.mock('../onboarding/AgentFeatureCard', () => ({
  AgentFeatureCard: ({ title }: { title: string }) => (
    <div data-testid={`agent-${title}`}>{title}</div>
  ),
}));

// crypto.randomUUID stub for Toast
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Date.now()}-${Math.random()}` });

// ─── Imports (after mocks) ───────────────────────────────────────────
import { EmptyState } from '../chat/EmptyState';
import { ChatHeader } from '../chat/ChatHeader';
import { ToastContainer, toast } from '../ui/Toast';
import { Skeleton } from '../ui/Skeleton';

// =====================================================================
// 1. EmptyState
// =====================================================================
describe('EmptyState', () => {
  it('renders welcome message "Merhaba! Ben AKIS."', () => {
    render(<EmptyState variant="new-conversation" />);
    expect(screen.getByText(/Merhaba! Ben/)).toBeInTheDocument();
    expect(screen.getByText('AKIS')).toBeInTheDocument();
  });

  it('shows agent flow: Scribe -> Proto -> Trace', () => {
    render(<EmptyState variant="new-conversation" />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Proto')).toBeInTheDocument();
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });

  it('"Yeni Sohbet Baslat" button calls onNewConversation', () => {
    const onNew = vi.fn();
    render(<EmptyState variant="no-conversation" onNewConversation={onNew} />);
    const btn = screen.getByRole('button', { name: /Yeni Sohbet Baslat/i });
    fireEvent.click(btn);
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('renders variant "no-conversation" with agent feature cards', () => {
    render(<EmptyState variant="no-conversation" onNewConversation={vi.fn()} />);
    expect(screen.getByTestId('agent-Scribe')).toBeInTheDocument();
    expect(screen.getByTestId('agent-Proto')).toBeInTheDocument();
    expect(screen.getByTestId('agent-Trace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yeni Sohbet Baslat/i })).toBeInTheDocument();
  });
});

// =====================================================================
// 2. ChatHeader
// =====================================================================
describe('ChatHeader', () => {
  const base = { repoShortName: 'todo-app', repoFullName: 'testuser/todo-app' };

  it('shows repo name', () => {
    render(<ChatHeader {...base} />);
    expect(screen.getByText('todo-app')).toBeInTheDocument();
  });

  it('shows branch name', () => {
    render(<ChatHeader {...base} branch="feat/auth" />);
    expect(screen.getByText('feat/auth')).toBeInTheDocument();
  });

  it.each(['ask', 'plan', 'act', 'review'] as const)(
    'mode badge renders correctly for mode=%s',
    (mode) => {
      render(<ChatHeader {...base} mode={mode} />);
      expect(screen.getByText(mode)).toBeInTheDocument();
    },
  );

  it('preview button visible when hasPreview=true', () => {
    render(
      <ChatHeader {...base} hasPreview showPreview={false} onTogglePreview={vi.fn()} />,
    );
    expect(screen.getByLabelText('Preview aç')).toBeInTheDocument();
  });

  it('preview button hidden when hasPreview=false', () => {
    render(<ChatHeader {...base} />);
    expect(screen.queryByLabelText('Preview aç')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preview kapat')).not.toBeInTheDocument();
  });
});

// =====================================================================
// 3. Toast
// =====================================================================
describe('Toast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toast() function adds notification', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Operation successful', 'success');
    });
    expect(screen.getByText('Operation successful')).toBeInTheDocument();
  });

  it('auto-dismisses after timeout', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastContainer />);
    act(() => {
      toast('Temporary toast', 'info');
    });
    expect(screen.getByText('Temporary toast')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('Temporary toast')).toBeNull();
    vi.useRealTimers();
  });

  it('error variant has red styling class', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Something went wrong', 'error');
    });
    const el =
      screen.getByText('Something went wrong').closest('[role] > div') ??
      screen.getByText('Something went wrong').parentElement;
    expect(el?.className).toContain('text-red-400');
  });
});

// =====================================================================
// 4. Skeleton
// =====================================================================
describe('Skeleton', () => {
  it('renders with custom className', () => {
    const { container } = render(<Skeleton className="h-5 w-1/3" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain('h-5');
    expect(el?.className).toContain('w-1/3');
  });

  it('has animation class', () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild;
    expect(el?.className).toContain('animate-pulse');
  });
});
