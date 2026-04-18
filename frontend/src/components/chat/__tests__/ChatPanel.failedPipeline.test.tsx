import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel';
import type { PipelineError } from '../../../types/pipeline';

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
  useAuth: () => ({ user: { name: 'Test', hasSeenBetaWelcome: true }, loading: false }),
}));

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../onboarding/WelcomeWizard', () => ({
  WelcomeWizard: () => <div data-testid="welcome-wizard" />,
}));

vi.mock('../../onboarding/AgentFeatureCard', () => ({
  AgentFeatureCard: ({ title }: { title: string }) => <div data-testid={`agent-${title}`}>{title}</div>,
}));

vi.mock('../PlanCard', () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const failedError: PipelineError = {
  code: 'PROTO_PUSH_FAILED',
  message: 'GitHub\'a kod gönderilemedi. Bağlantınızı kontrol edin.',
  retryable: true,
};

const defaultProps = {
  conversationId: 'conv-failed',
  repoShortName: 'todo-app',
  repoFullName: 'user/todo-app',
  messages: [
    { type: 'user' as const, content: 'Test fikri', timestamp: '2024-01-15T10:00:00Z' },
    { type: 'info' as const, content: 'Pipeline başlatıldı.', timestamp: '2024-01-15T10:01:00Z' },
  ],
  uiState: 'idle' as const,
  isInputEnabled: true,
  showCancelButton: false,
  inputPlaceholder: 'Pipeline başarısız oldu...',
  onSend: vi.fn(),
  onCancel: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onRetry: vi.fn(),
  onSkip: vi.fn(),
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ChatPanel — failed pipeline', () => {
  it('renders error banner when pipelineError is provided', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByTestId('pipeline-error-banner')).toBeInTheDocument();
  });

  it('shows error message in banner', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByText(failedError.message)).toBeInTheDocument();
  });

  it('shows error code chip in banner', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByText('PROTO_PUSH_FAILED')).toBeInTheDocument();
  });

  it('shows "Tekrar Dene" retry button when error.retryable is true', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(screen.getByText('Tekrar Dene')).toBeInTheDocument();
  });

  it('calls onRetry handler when retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<ChatPanel {...defaultProps} pipelineError={failedError} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows "Trace\'i Atla" button when recoveryAction is skip-trace', () => {
    const skipTraceError: PipelineError = {
      code: 'TRACE_TIMEOUT',
      message: 'Trace zaman aşımına uğradı.',
      retryable: false,
      recoveryAction: 'skip-trace',
    };
    render(<ChatPanel {...defaultProps} pipelineError={skipTraceError} />);

    expect(screen.getByTestId('skip-trace-button')).toBeInTheDocument();
  });

  it('does NOT render error banner when pipelineError is undefined', () => {
    render(<ChatPanel {...defaultProps} pipelineError={undefined} />);

    expect(screen.queryByTestId('pipeline-error-banner')).not.toBeInTheDocument();
  });

  it('renders chat messages alongside the error banner', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByText('Test fikri')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-error-banner')).toBeInTheDocument();
  });

  it('renders HATA chip in header when pipelineError is provided', () => {
    render(<ChatPanel {...defaultProps} pipelineError={failedError} />);

    expect(screen.getByText('HATA')).toBeInTheDocument();
  });

  it('does NOT render HATA chip when no error', () => {
    render(<ChatPanel {...defaultProps} pipelineError={undefined} />);

    expect(screen.queryByText('HATA')).not.toBeInTheDocument();
  });
});
