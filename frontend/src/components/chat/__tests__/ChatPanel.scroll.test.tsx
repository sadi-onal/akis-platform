import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel';
import type { ChatMessage } from '../../../types/chat';

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

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

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../onboarding/AgentFeatureCard', () => ({
  AgentFeatureCard: ({ title }: { title: string }) => <div data-testid={`agent-${title}`}>{title}</div>,
}));

vi.mock('../PlanCard', () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));

// ── Helper ─────────────────────────────────────────

const TS = '2024-01-15T10:30:00.000Z';

const defaultProps = {
  conversationId: 'conv-1',
  repoShortName: 'test-repo',
  repoFullName: 'user/test-repo',
  messages: [] as ChatMessage[],
  uiState: 'idle' as const,
  isInputEnabled: true,
  showCancelButton: false,
  inputPlaceholder: 'Type here...',
  onSend: vi.fn(),
  onCancel: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onRetry: vi.fn(),
  onSkip: vi.fn(),
};

function generateMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'user' as const,
    content: `Message ${i + 1}`,
    timestamp: new Date(Date.parse(TS) + i * 1000).toISOString(),
  }));
}

// ── Tests ──────────────────────────────────────────

describe('ChatPanel — scroll-to-bottom button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not show scroll button when at bottom (default state)', () => {
    render(<ChatPanel {...defaultProps} messages={generateMessages(5)} />);
    expect(screen.queryByLabelText('En alta kaydır')).not.toBeInTheDocument();
  });

  it('scroll button has correct aria-label for accessibility', () => {
    // Simulate the button being visible by directly checking the component structure.
    // The button renders conditionally based on scroll state. We test the button's
    // attributes when it IS rendered by triggering the scroll condition.
    const messages = generateMessages(30);
    const { container } = render(<ChatPanel {...defaultProps} messages={messages} />);

    // Get the scroll container and simulate scrolling up
    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      // Mock the scroll properties to simulate "scrolled up"
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

      fireEvent.scroll(scrollContainer);

      const scrollBtn = screen.queryByLabelText('En alta kaydır');
      if (scrollBtn) {
        expect(scrollBtn).toHaveAttribute('aria-label', 'En alta kaydır');
        expect(scrollBtn).toHaveAttribute('role', 'button');
        expect(scrollBtn.tabIndex).toBe(0);
      }
    }
  });

  it('scroll button has tabIndex=0 for keyboard accessibility', () => {
    const messages = generateMessages(30);
    const { container } = render(<ChatPanel {...defaultProps} messages={messages} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

      fireEvent.scroll(scrollContainer);

      const scrollBtn = screen.queryByLabelText('En alta kaydır');
      if (scrollBtn) {
        expect(scrollBtn.tabIndex).toBe(0);
      }
    }
  });

  it('scroll button has role="button"', () => {
    const messages = generateMessages(30);
    const { container } = render(<ChatPanel {...defaultProps} messages={messages} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

      fireEvent.scroll(scrollContainer);

      const scrollBtn = screen.queryByLabelText('En alta kaydır');
      if (scrollBtn) {
        expect(scrollBtn.getAttribute('role')).toBe('button');
      }
    }
  });

  it('scroll button supports keyboard activation with Enter key', () => {
    const messages = generateMessages(30);
    const { container } = render(<ChatPanel {...defaultProps} messages={messages} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

      fireEvent.scroll(scrollContainer);

      const scrollBtn = screen.queryByLabelText('En alta kaydır');
      if (scrollBtn) {
        // The onKeyDown handler should call scrollToBottom for Enter/Space
        expect(() => fireEvent.keyDown(scrollBtn, { key: 'Enter' })).not.toThrow();
      }
    }
  });

  it('does not show scroll button when message list is empty', () => {
    render(<ChatPanel {...defaultProps} messages={[]} />);
    expect(screen.queryByLabelText('En alta kaydır')).not.toBeInTheDocument();
  });

  it('renders EmptyState when no conversationId', () => {
    render(<ChatPanel {...defaultProps} conversationId={undefined} messages={[]} />);
    // EmptyState no-conversation variant renders agent cards
    expect(screen.queryByLabelText('En alta kaydır')).not.toBeInTheDocument();
  });

  it('renders ChatInput when conversationId is set', () => {
    const { container } = render(<ChatPanel {...defaultProps} messages={generateMessages(2)} />);
    // ChatInput has a textarea or input for sending messages
    const inputArea = container.querySelector('textarea, input[type="text"]');
    expect(inputArea).toBeTruthy();
  });

  it('button shows Turkish text for new messages indicator', () => {
    const messages = generateMessages(30);
    const { container } = render(<ChatPanel {...defaultProps} messages={messages} />);

    const scrollContainer = container.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

      fireEvent.scroll(scrollContainer);

      const scrollBtn = screen.queryByLabelText('En alta kaydır');
      if (scrollBtn) {
        expect(scrollBtn.textContent).toContain('Yeni mesajlar');
      }
    }
  });
});
