import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConversationSidebar } from '../ConversationSidebar';
import type { ConversationListItem } from '../../../types/chat';

// ─── Mocks ────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/chat' }),
}));

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com' },
    logout: vi.fn(),
  }),
}));

vi.mock('../../../theme/useTheme', () => ({
  useTheme: () => ({ isDark: true, toggleTheme: vi.fn() }),
}));

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/logo.svg',
}));

vi.mock('../ConversationItem', () => ({
  ConversationItem: ({ title, isActive, onClick }: { title: string; isActive: boolean; onClick: () => void }) => (
    <button data-testid={`conv-${title}`} data-active={isActive} onClick={onClick}>
      {title}
    </button>
  ),
}));

// ─── Helpers ──────────────────────────────────────

function makeConv(overrides: Partial<ConversationListItem> & { id: string; title: string }): ConversationListItem {
  return {
    repoFullName: 'user/repo',
    repoShortName: 'repo',
    status: 'completed',
    fileCount: 3,
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

const TODAY = new Date();
const YESTERDAY = new Date(TODAY.getTime() - 86400000);
const LAST_WEEK = new Date(TODAY.getTime() - 3 * 86400000);
const OLD = new Date(TODAY.getTime() - 30 * 86400000);

const conversations: ConversationListItem[] = [
  makeConv({ id: '1', title: 'Todo App', lastActivity: TODAY.toISOString() }),
  makeConv({ id: '2', title: 'Blog Platform', lastActivity: YESTERDAY.toISOString() }),
  makeConv({ id: '3', title: 'E-commerce', lastActivity: LAST_WEEK.toISOString() }),
  makeConv({ id: '4', title: 'Old Project', lastActivity: OLD.toISOString() }),
];

beforeEach(() => vi.clearAllMocks());

// ─── Tests ────────────────────────────────────────

describe('ConversationSidebar', () => {
  it('renders conversation list', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conv-Todo App')).toBeInTheDocument();
    expect(screen.getByTestId('conv-Blog Platform')).toBeInTheDocument();
    expect(screen.getByTestId('conv-E-commerce')).toBeInTheDocument();
    expect(screen.getByTestId('conv-Old Project')).toBeInTheDocument();
  });

  it('shows empty state when no conversations', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByText('Henüz sohbet yok.')).toBeInTheDocument();
    expect(screen.getByText('Yeni Sohbet Başlat')).toBeInTheDocument();
  });

  it('shows "Sonuç bulunamadı." when search has no results', () => {
    vi.useFakeTimers();
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={vi.fn()}
      />,
    );
    const searchInput = screen.getByLabelText('Sohbet ara');
    fireEvent.change(searchInput, { target: { value: 'nonexistent query' } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText('Sonuç bulunamadı.')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('filters conversations by search', () => {
    vi.useFakeTimers();
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={vi.fn()}
      />,
    );
    const searchInput = screen.getByLabelText('Sohbet ara');
    fireEvent.change(searchInput, { target: { value: 'Todo' } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId('conv-Todo App')).toBeInTheDocument();
    expect(screen.queryByTestId('conv-Blog Platform')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('calls onNewConversation on button click', () => {
    const onNew = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={onNew}
      />,
    );
    fireEvent.click(screen.getByText('Yeni Sohbet'));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('highlights active conversation', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        activeId="2"
        onNewConversation={vi.fn()}
      />,
    );
    const active = screen.getByTestId('conv-Blog Platform');
    expect(active.dataset.active).toBe('true');
  });

  it('navigates to conversation on click', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('conv-Todo App'));
    expect(mockNavigate).toHaveBeenCalledWith('/chat/1');
  });

  it('renders date group labels', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByText('Bugün')).toBeInTheDocument();
    expect(screen.getByText('Dün')).toBeInTheDocument();
    expect(screen.getByText('Daha Eski')).toBeInTheDocument();
  });

  it('shows AKIS logo', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByAltText('AKIS')).toBeInTheDocument();
  });

  it('shows version text', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByText(/AKIS v0\.5\.3/)).toBeInTheDocument();
  });

  it('shows theme toggle button', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Aydınlık mod')).toBeInTheDocument();
  });

  it('shows settings button', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Ayarlar')).toBeInTheDocument();
  });

  it('shows user info when user is logged in', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('renders new conversation button in collapsed mode', () => {
    render(
      <ConversationSidebar
        conversations={[]}
        collapsed
        onNewConversation={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Yeni Sohbet')).toBeInTheDocument();
  });
});
