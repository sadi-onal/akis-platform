/**
 * P9 — ChatPanel Trace toggle visibility tests.
 *
 * The user's complaint was "Trace hiç çalışmadı" even though TraceAgent is
 * fully implemented and active. Root cause was a mismatched default + the
 * lack of a clear signal in the UI about whether Trace would run. These
 * tests pin the visible behavior so a future refactor can't silently strip
 * the label or flip the default again.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel';

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// ── Mocks ──────────────────────────────────────────────────────────────────

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
  AgentFeatureCard: ({ title }: { title: string }) => (
    <div data-testid={`agent-${title}`}>{title}</div>
  ),
}));

vi.mock('../PlanCard', () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const defaultProps = {
  conversationId: 'conv-1',
  repoShortName: 'todo-app',
  repoFullName: 'user/todo-app',
  messages: [
    { type: 'user' as const, content: 'Test fikri', timestamp: '2024-01-15T10:00:00Z' },
  ],
  uiState: 'idle' as const,
  isInputEnabled: true,
  showCancelButton: false,
  inputPlaceholder: 'Yaz...',
  onSend: vi.fn(),
  onCancel: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onRetry: vi.fn(),
  onSkip: vi.fn(),
};

// ── Toggle label tests ─────────────────────────────────────────────────────

describe('ChatPanel — trace toggle label clarity (P9)', () => {
  it('shows "Trace açık" label when traceEnabled=true', () => {
    render(
      <ChatPanel
        {...defaultProps}
        traceEnabled={true}
        onTraceToggle={vi.fn()}
      />,
    );

    const label = screen.getByTestId('trace-toggle-label');
    expect(label.textContent).toMatch(/Trace açık/);
    expect(label.textContent).toMatch(/testler üretilecek/);
  });

  it('shows "Trace kapalı" label when traceEnabled=false', () => {
    render(
      <ChatPanel
        {...defaultProps}
        traceEnabled={false}
        onTraceToggle={vi.fn()}
      />,
    );

    const label = screen.getByTestId('trace-toggle-label');
    expect(label.textContent).toMatch(/Trace kapalı/);
    expect(label.textContent).toMatch(/sadece kod/);
  });

  it('switch role reflects aria-checked=true when traceEnabled=true', () => {
    render(
      <ChatPanel
        {...defaultProps}
        traceEnabled={true}
        onTraceToggle={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('switch role reflects aria-checked=false when traceEnabled=false', () => {
    render(
      <ChatPanel
        {...defaultProps}
        traceEnabled={false}
        onTraceToggle={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('flips traceEnabled when toggle is clicked', () => {
    const onTraceToggle = vi.fn();
    render(
      <ChatPanel
        {...defaultProps}
        traceEnabled={true}
        onTraceToggle={onTraceToggle}
      />,
    );

    fireEvent.click(screen.getByRole('switch'));
    expect(onTraceToggle).toHaveBeenCalledWith(false);
  });

  it('does NOT render toggle when onTraceToggle is omitted', () => {
    render(<ChatPanel {...defaultProps} />);

    expect(screen.queryByTestId('trace-toggle')).not.toBeInTheDocument();
  });
});

// ── Early "Trace will run" hint ────────────────────────────────────────────

describe('ChatPanel — trace pending hint (P9)', () => {
  it('shows hint when proto is running and trace is enabled', () => {
    render(
      <ChatPanel
        {...defaultProps}
        uiState="proto_running"
        traceEnabled={true}
      />,
    );

    expect(screen.getByTestId('trace-pending-hint')).toBeInTheDocument();
    expect(screen.getByTestId('trace-pending-hint').textContent).toMatch(/Trace çalışacak/);
  });

  it('shows hint at awaiting_approval when trace is enabled', () => {
    render(
      <ChatPanel
        {...defaultProps}
        uiState="awaiting_approval"
        traceEnabled={true}
      />,
    );

    expect(screen.getByTestId('trace-pending-hint')).toBeInTheDocument();
  });

  it('does NOT show hint when traceEnabled=false', () => {
    render(
      <ChatPanel
        {...defaultProps}
        uiState="proto_running"
        traceEnabled={false}
      />,
    );

    expect(screen.queryByTestId('trace-pending-hint')).not.toBeInTheDocument();
  });

  it('does NOT show hint at idle even when trace is enabled (no pipeline yet)', () => {
    render(
      <ChatPanel
        {...defaultProps}
        uiState="idle"
        traceEnabled={true}
      />,
    );

    expect(screen.queryByTestId('trace-pending-hint')).not.toBeInTheDocument();
  });
});
