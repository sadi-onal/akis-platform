import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatMessage } from '../ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../../types/chat';
import type { UserFriendlyPlan } from '../../../types/plan';

// Mock PlanCard to isolate ChatMessage rendering from PlanCard internals
vi.mock('../PlanCard', () => ({
  PlanCard: ({ plan, status, onApprove, onReject }: {
    plan: UserFriendlyPlan;
    version: number;
    status: string;
    isChangeRequest: boolean;
    onApprove?: () => void;
    onReject?: () => void;
  }) => (
    <div data-testid="plan-card" data-status={status} data-project={('projectName' in plan) ? plan.projectName : ''}>
      <button onClick={onApprove}>Approve</button>
      <button onClick={onReject}>Reject</button>
    </div>
  ),
}));

// Mock useI18n used inside PlanCard (guarded in case it leaks through)
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

const TS = '2024-01-15T10:30:00.000Z';

// ─── 1. User message ────────────────────────────────────────────────────────

describe('ChatMessage — user', () => {
  const msg: ChatMessageType = { type: 'user', content: 'Hello world', timestamp: TS };

  it('renders content text', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('is right-aligned (flex justify-end wrapper)', () => {
    const { container } = render(<ChatMessage message={msg} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('justify-end');
  });
});

// ─── 2. Agent message ────────────────────────────────────────────────────────

describe('ChatMessage — agent', () => {
  it('renders scribe label and content', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'scribe', content: 'Processing your idea', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Processing your idea')).toBeInTheDocument();
  });

  it('renders proto label', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'proto', content: 'Building scaffold', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Proto')).toBeInTheDocument();
  });

  it('renders trace label', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'trace', content: 'Writing tests', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });

  it('shows agent avatar initial for scribe', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'scribe', content: 'Hello', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('has a copy button with title "Kopyala"', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'scribe', content: 'Copy me', timestamp: TS };
    render(<ChatMessage message={msg} />);
    const copyBtn = screen.getByTitle('Kopyala');
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn.tagName).toBe('BUTTON');
  });

  it('calls navigator.clipboard.writeText when copy button is clicked', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const msg: ChatMessageType = { type: 'agent', agent: 'proto', content: 'Code snippet here', timestamp: TS };
    render(<ChatMessage message={msg} />);
    fireEvent.click(screen.getByTitle('Kopyala'));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('Code snippet here');
  });

  it('copy button is inside the agent message group container', () => {
    const msg: ChatMessageType = { type: 'agent', agent: 'trace', content: 'Test output', timestamp: TS };
    const { container } = render(<ChatMessage message={msg} />);
    const group = container.querySelector('.group');
    expect(group).toBeInTheDocument();
    const copyBtn = group?.querySelector('button[title="Kopyala"]');
    expect(copyBtn).toBeInTheDocument();
  });
});

// ─── 3. Clarification message ────────────────────────────────────────────────

describe('ChatMessage — clarification', () => {
  const msg: ChatMessageType = {
    type: 'clarification',
    role: 'scribe',
    content: 'I need some more info',
    questions: [
      {
        id: 'q1',
        question: 'What is the target platform?',
        reason: 'Helps narrow the stack',
        suggestions: ['Web', 'Mobile', 'Desktop'],
      },
      {
        id: 'q2',
        question: 'Do you need authentication?',
        reason: 'Affects scope',
      },
    ],
    timestamp: TS,
  };

  it('renders agent label for clarification role', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
  });

  it('renders clarification intro content', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('I need some more info')).toBeInTheDocument();
  });

  it('renders all questions', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/What is the target platform\?/)).toBeInTheDocument();
    expect(screen.getByText(/Do you need authentication\?/)).toBeInTheDocument();
  });

  it('renders suggestion badges', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText('Mobile')).toBeInTheDocument();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
  });

  it('renders suggestion badges as read-only (no buttons)', () => {
    render(<ChatMessage message={msg} />);
    // Historical clarification badges are display-only spans, not interactive buttons
    expect(screen.queryByRole('button', { name: 'Web' })).not.toBeInTheDocument();
    expect(screen.getByText('Web').tagName).toBe('SPAN');
  });

  it('clicking a historical suggestion does not throw', () => {
    render(<ChatMessage message={msg} />);
    expect(() => fireEvent.click(screen.getByText('Mobile'))).not.toThrow();
  });
});

// ─── 4. Plan message ─────────────────────────────────────────────────────────

describe('ChatMessage — plan', () => {
  const plan: UserFriendlyPlan = {
    projectName: 'My App',
    summary: 'A simple to-do app',
    features: [{ name: 'Task list', description: 'CRUD tasks' }],
    techChoices: ['React', 'Fastify'],
    estimatedFiles: 10,
    requiresTests: true,
  };

  it('renders the mocked PlanCard', () => {
    const msg: ChatMessageType = { type: 'plan', plan, version: 1, status: 'active', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByTestId('plan-card')).toBeInTheDocument();
  });

  it('passes plan project name to PlanCard', () => {
    const msg: ChatMessageType = { type: 'plan', plan, version: 1, status: 'active', timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByTestId('plan-card')).toHaveAttribute('data-project', 'My App');
  });

  it('calls onApprove when plan is active and approve button clicked', () => {
    const handleApprove = vi.fn();
    const msg: ChatMessageType = { type: 'plan', plan, version: 1, status: 'active', timestamp: TS };
    render(<ChatMessage message={msg} onApprove={handleApprove} />);
    fireEvent.click(screen.getByText('Approve'));
    expect(handleApprove).toHaveBeenCalledOnce();
  });

  it('does not pass onApprove when plan is not active', () => {
    const handleApprove = vi.fn();
    const msg: ChatMessageType = { type: 'plan', plan, version: 1, status: 'approved', timestamp: TS };
    render(<ChatMessage message={msg} onApprove={handleApprove} />);
    // The mocked PlanCard receives undefined onApprove, clicking its button is a no-op
    fireEvent.click(screen.getByText('Approve'));
    expect(handleApprove).not.toHaveBeenCalled();
  });
});

// ─── 5. file_created message ─────────────────────────────────────────────────

describe('ChatMessage — file_created', () => {
  const msg: ChatMessageType = { type: 'file_created', path: 'src/index.ts', repo: 'my-repo', timestamp: TS };

  it('shows the file path', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
  });

  it('shows a success checkmark', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });
});

// ─── 6. pr_opened message ────────────────────────────────────────────────────

describe('ChatMessage — pr_opened', () => {
  const msg: ChatMessageType = {
    type: 'pr_opened',
    url: 'https://github.com/owner/repo/pull/42',
    number: 42,
    title: 'feat: add login page',
    branch: 'proto/scaffold-20240115',
    filesChanged: 7,
    linesChanged: 312,
    timestamp: TS,
  };

  it('shows PR title', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('feat: add login page')).toBeInTheDocument();
  });

  it('shows branch name', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('proto/scaffold-20240115')).toBeInTheDocument();
  });

  it('shows files changed count', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('7 dosya')).toBeInTheDocument();
  });

  it('shows a link to GitHub', () => {
    render(<ChatMessage message={msg} />);
    const link = screen.getByRole('link', { name: /GitHub'da Gör/ });
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

// ─── 7. test_result — all passing ────────────────────────────────────────────

describe('ChatMessage — test_result (all passing)', () => {
  const msg: ChatMessageType = {
    type: 'test_result',
    passed: 12,
    failed: 0,
    total: 12,
    coverage: '87',
    timestamp: TS,
  };

  it('shows passed count', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows coverage percentage', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('87%')).toBeInTheDocument();
  });

  it('does not show failed count when 0 failures', () => {
    render(<ChatMessage message={msg} />);
    // "başarısız" label should not appear when failed === 0
    expect(screen.queryByText('başarısız')).not.toBeInTheDocument();
  });

  it('does not show retry/skip buttons when no failures', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(<ChatMessage message={msg} onRetry={onRetry} onSkip={onSkip} />);
    expect(screen.queryByText(/Trace'e Düzelttir/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Geç/)).not.toBeInTheDocument();
  });
});

// ─── 8. test_result — with failures ──────────────────────────────────────────

describe('ChatMessage — test_result (with failures)', () => {
  const msg: ChatMessageType = {
    type: 'test_result',
    passed: 5,
    failed: 3,
    total: 8,
    coverage: '62',
    failures: [
      { file: 'src/auth.test.ts', line: 42, message: 'Expected 200 got 401' },
      { file: 'src/api.test.ts', line: 18, message: 'Timeout exceeded' },
    ],
    timestamp: TS,
  };

  it('shows failed count', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows failure file and message details', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/src\/auth\.test\.ts:42/)).toBeInTheDocument();
    expect(screen.getByText(/Expected 200 got 401/)).toBeInTheDocument();
  });

  it('shows retry button when onRetry provided', () => {
    const onRetry = vi.fn();
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    expect(screen.getByText(/Trace'e Düzelttir/)).toBeInTheDocument();
  });

  it('shows skip button when onSkip provided', () => {
    const onSkip = vi.fn();
    render(<ChatMessage message={msg} onSkip={onSkip} />);
    expect(screen.getByText(/Geç/)).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn();
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    fireEvent.click(screen.getByText(/Trace'e Düzelttir/));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('calls onSkip when skip button clicked', () => {
    const onSkip = vi.fn();
    render(<ChatMessage message={msg} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/Geç/));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

// ─── 9. error message ────────────────────────────────────────────────────────

describe('ChatMessage — error', () => {
  it('shows error message text', () => {
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'GitHub token expired', retryable: false, timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('GitHub token expired')).toBeInTheDocument();
  });

  it('shows "Hata" heading', () => {
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'Something failed', retryable: false, timestamp: TS };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Hata')).toBeInTheDocument();
  });

  it('shows retry button when retryable and onRetry provided', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'Network error', retryable: true, timestamp: TS };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    expect(screen.getByText(/Tekrar Dene/)).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'Network error', retryable: true, timestamp: TS };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    fireEvent.click(screen.getByText(/Tekrar Dene/));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not show retry button when retryable is false', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'Fatal error', retryable: false, timestamp: TS };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    expect(screen.queryByText(/Tekrar Dene/)).not.toBeInTheDocument();
  });

  it('shows skip button when retryable and onSkip provided', () => {
    const onSkip = vi.fn();
    const msg: ChatMessageType = { type: 'error', agent: 'proto', message: 'Network error', retryable: true, timestamp: TS };
    render(<ChatMessage message={msg} onSkip={onSkip} />);
    expect(screen.getByText(/Atla/)).toBeInTheDocument();
  });
});

// ─── 10. info message ────────────────────────────────────────────────────────

describe('ChatMessage — info', () => {
  const msg: ChatMessageType = { type: 'info', content: 'Pipeline started', timestamp: TS };

  it('renders content text', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Pipeline started')).toBeInTheDocument();
  });

  it('is centered (flex justify-center wrapper)', () => {
    const { container } = render(<ChatMessage message={msg} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('justify-center');
  });
});
