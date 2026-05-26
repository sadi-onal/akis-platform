import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ChatMessage now uses useI18n — mock it so tests render without I18nProvider.
// Keys return their Turkish values to keep existing assertions stable.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const msgs: Record<string, string> = {
        'chat.message.testPlanAiEstimate': 'Test Planı (AI Tahmini)',
        'chat.message.testPlanAiEstimateNote':
          'Bu veriler Trace\'in AI tahminidir, gerçek test koşturma sonucu değildir.',
        'chat.message.testPlanPassed': 'başarılı',
        'chat.message.testPlanFailed': 'başarısız',
        'chat.message.testPlanCoverage': 'kapsam',
        'chat.message.testHelperFiles': 'Test ve yardımcı dosyalar',
        'chat.message.testHelperLabel': 'yardımcı',
        'chat.message.testCriteriaNotCovered': 'kriter kapsanmadı',
        'chat.message.testSteps': 'adım',
        'chat.message.testIteration': 'İterasyon',
      };
      return msgs[key] ?? key;
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { ChatMessage } from '../ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../../types/chat';
import type { UserFriendlyPlan } from '../../../types/plan';

// Mock PlanCard to isolate ChatMessage rendering from PlanCard internals
vi.mock('../PlanCard', () => ({
  PlanCard: ({
    plan,
    status,
    onApprove,
    onReject,
  }: {
    plan: UserFriendlyPlan;
    version: number;
    status: string;
    isChangeRequest: boolean;
    onApprove?: () => void;
    onReject?: () => void;
  }) => (
    <div
      data-testid="plan-card"
      data-status={status}
      data-project={'projectName' in plan ? plan.projectName : ''}
    >
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

// ─── 1b. User message with image attachments (issue #464 BUG-C) ────────────

describe('ChatMessage — user with images', () => {
  const singleImage: ChatMessageType = {
    type: 'user',
    content: 'Buna benzer yap',
    timestamp: TS,
    images: [
      {
        id: 'img-1',
        name: 'mockup.png',
        previewUrl: 'blob:http://local/mockup',
        mimeType: 'image/png',
      },
    ],
  };

  const threeImages: ChatMessageType = {
    type: 'user',
    content: 'Bu 3 ekranı birleştir',
    timestamp: TS,
    images: [
      { id: 'img-1', name: 'a.png', previewUrl: 'blob:a', mimeType: 'image/png' },
      { id: 'img-2', name: 'b.png', previewUrl: 'blob:b', mimeType: 'image/png' },
      { id: 'img-3', name: 'c.png', previewUrl: 'blob:c', mimeType: 'image/png' },
    ],
  };

  it('renders a thumbnail img tag for a single image', () => {
    render(<ChatMessage message={singleImage} />);
    const img = screen.getByAltText('mockup.png') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('blob:http://local/mockup');
  });

  it('does not render image block when images array is absent', () => {
    const plain: ChatMessageType = { type: 'user', content: 'just text', timestamp: TS };
    render(<ChatMessage message={plain} />);
    // No img elements should exist in a plain user bubble
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders a grid with all 3 images when multi-image message', () => {
    render(<ChatMessage message={threeImages} />);
    expect(screen.getByAltText('a.png')).toBeInTheDocument();
    expect(screen.getByAltText('b.png')).toBeInTheDocument();
    expect(screen.getByAltText('c.png')).toBeInTheDocument();
    // 3 images → 3 img tags
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('each thumbnail is wrapped in a button to trigger full-size preview', () => {
    render(<ChatMessage message={singleImage} />);
    const btn = screen.getByRole('button', { name: /mockup\.png.*büyüt/ });
    expect(btn).toBeInTheDocument();
  });

  it('clicking a thumbnail opens the preview modal with the same image', () => {
    render(<ChatMessage message={singleImage} />);
    const btn = screen.getByRole('button', { name: /mockup\.png.*büyüt/ });
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Modal img uses the same src
    const imgs = screen.getAllByAltText('mockup.png');
    expect(imgs.length).toBeGreaterThanOrEqual(2); // thumb + modal
  });

  it('clicking the close button dismisses the preview modal', () => {
    render(<ChatMessage message={singleImage} />);
    fireEvent.click(screen.getByRole('button', { name: /mockup\.png.*büyüt/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape key dismisses the preview modal', () => {
    render(<ChatMessage message={singleImage} />);
    fireEvent.click(screen.getByRole('button', { name: /mockup\.png.*büyüt/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// ─── 2. Agent message ────────────────────────────────────────────────────────

describe('ChatMessage — agent', () => {
  it('renders scribe label and content', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'Processing your idea',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Processing your idea')).toBeInTheDocument();
  });

  it('renders proto label', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Building scaffold',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Proto')).toBeInTheDocument();
  });

  it('renders trace label', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'trace',
      content: 'Writing tests',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });

  it('shows agent avatar initial for scribe', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'Hello',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('has a copy button with title "Kopyala"', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'Copy me',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    const copyBtn = screen.getByTitle('Kopyala');
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn.tagName).toBe('BUTTON');
  });

  it('calls navigator.clipboard.writeText when copy button is clicked', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Code snippet here',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    fireEvent.click(screen.getByTitle('Kopyala'));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('Code snippet here');
  });

  it('copy button is inside the agent message group container', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'trace',
      content: 'Test output',
      timestamp: TS,
    };
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
    const msg: ChatMessageType = {
      type: 'plan',
      plan,
      version: 1,
      status: 'active',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByTestId('plan-card')).toBeInTheDocument();
  });

  it('passes plan project name to PlanCard', () => {
    const msg: ChatMessageType = {
      type: 'plan',
      plan,
      version: 1,
      status: 'active',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByTestId('plan-card')).toHaveAttribute('data-project', 'My App');
  });

  it('calls onApprove when plan is active and approve button clicked', () => {
    const handleApprove = vi.fn();
    const msg: ChatMessageType = {
      type: 'plan',
      plan,
      version: 1,
      status: 'active',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} onApprove={handleApprove} />);
    fireEvent.click(screen.getByText('Approve'));
    expect(handleApprove).toHaveBeenCalledOnce();
  });

  it('does not pass onApprove when plan is not active', () => {
    const handleApprove = vi.fn();
    const msg: ChatMessageType = {
      type: 'plan',
      plan,
      version: 1,
      status: 'approved',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} onApprove={handleApprove} />);
    // The mocked PlanCard receives undefined onApprove, clicking its button is a no-op
    fireEvent.click(screen.getByText('Approve'));
    expect(handleApprove).not.toHaveBeenCalled();
  });
});

// ─── 5. file_created message ─────────────────────────────────────────────────

describe('ChatMessage — file_created', () => {
  const msg: ChatMessageType = {
    type: 'file_created',
    path: 'src/index.ts',
    repo: 'my-repo',
    timestamp: TS,
  };

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

// ─── 8b. test_result — with executedTestResults ─────────────────────────────

describe('ChatMessage — test_result (with executedTestResults)', () => {
  const msg: ChatMessageType = {
    type: 'test_result',
    passed: 5,
    failed: 0,
    total: 5,
    coverage: '80',
    timestamp: TS,
    executedTestResults: {
      total: 3,
      passed: 2,
      failed: 1,
      passRate: 67,
      durationMs: 4200,
      details: [
        { name: 'login flow', status: 'passed', durationMs: 1200 },
        { name: 'signup flow', status: 'passed', durationMs: 1800 },
        { name: 'logout flow', status: 'failed', error: 'Element not found', durationMs: 1200 },
      ],
    },
  };

  it('shows the "Gerçek Test Sonuçları" heading', () => {
    render(<ChatMessage message={msg} />);
    // The mock returns the raw key for executedTestResults
    // because we only populated testPlan* keys in the mock map
    expect(screen.getByText('chat.message.executedTestResults')).toBeInTheDocument();
  });

  it('shows real passed count from executedTestResults', () => {
    render(<ChatMessage message={msg} />);
    // AI estimate passed=5, real passed=2 — both should be on screen
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows real failed count from executedTestResults', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows pass rate from executedTestResults', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('67%')).toBeInTheDocument();
  });

  it('shows failure error detail in collapsible section', () => {
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Element not found')).toBeInTheDocument();
  });
});

// ─── 9. error message ────────────────────────────────────────────────────────

describe('ChatMessage — error', () => {
  it('shows error message text', () => {
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'GitHub token expired',
      retryable: false,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('GitHub token expired')).toBeInTheDocument();
  });

  it('shows "Hata" heading', () => {
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'Something failed',
      retryable: false,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Hata')).toBeInTheDocument();
  });

  it('shows retry button when retryable and onRetry provided', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'Network error',
      retryable: true,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    expect(screen.getByText(/Tekrar Dene/)).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'Network error',
      retryable: true,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    fireEvent.click(screen.getByText(/Tekrar Dene/));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not show retry button when retryable is false', () => {
    const onRetry = vi.fn();
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'Fatal error',
      retryable: false,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} onRetry={onRetry} />);
    expect(screen.queryByText(/Tekrar Dene/)).not.toBeInTheDocument();
  });

  it('shows skip button when retryable and onSkip provided', () => {
    const onSkip = vi.fn();
    const msg: ChatMessageType = {
      type: 'error',
      agent: 'proto',
      message: 'Network error',
      retryable: true,
      timestamp: TS,
    };
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

// ─── 10b. agent message — Proto summary leads metadata (F-6) ───────────────

describe('ChatMessage — agent (Proto F-6 summary leads metadata)', () => {
  it('Proto row leads with summary, metadata is secondary (F-6)', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Scaffold oluşturuldu — 15 dosya, 552 satır',
      summary: 'Sayaç için React projesi hazırladım. Artırma, azaltma ve sıfırla çalışıyor.',
      totalFiles: 15,
      totalLines: 552,
      branch: 'feat/counter-app',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);

    const summaryEl = screen.getByText(/Sayaç için React projesi/);
    const metaEl = screen.getByTestId('proto-meta-secondary');

    expect(summaryEl).toBeInTheDocument();
    expect(metaEl).toBeInTheDocument();

    // DOM order: summary appears BEFORE metadata
    const order = summaryEl.compareDocumentPosition(metaEl);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Visual prominence: summary is text-sm, metadata is text-xs
    expect(summaryEl.className).toContain('text-sm');
    expect(metaEl.className).toContain('text-xs');

    // Metadata content includes file count, line count, branch — joined by ·
    expect(metaEl.textContent).toContain('15 dosya');
    expect(metaEl.textContent).toContain('552 satır');
    expect(metaEl.textContent).toContain('feat/counter-app');

    // The technical-jargon `content` ("Scaffold oluşturuldu — …") should NOT
    // leak into the rendered DOM when a summary is present.
    expect(screen.queryByText(/Scaffold oluşturuldu/)).not.toBeInTheDocument();
  });

  it('falls back to content when summary is absent (legacy pipelines, NF-1)', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Scaffold oluşturuldu — 14 dosya, 400 satır',
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Scaffold oluşturuldu/)).toBeInTheDocument();
    // No metadata secondary line because no structured fields were threaded
    expect(screen.queryByTestId('proto-meta-secondary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proto-summary-primary')).not.toBeInTheDocument();
  });

  it('renders metadata-only fields gracefully when summary is missing', () => {
    // Defensive: if a future caller threads totalFiles but forgets summary,
    // we still fall back to content (no orphan metadata block).
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Scaffold hazır',
      totalFiles: 10,
      totalLines: 200,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Scaffold hazır/)).toBeInTheDocument();
    expect(screen.queryByTestId('proto-meta-secondary')).not.toBeInTheDocument();
  });

  it('Scribe rows with summary show the summary, but NOT Proto-specific meta', () => {
    // Chat narrator (2026-05-23): all agents now render summary when present.
    // Proto-specific metadata (totalFiles/totalLines/branch shown as a
    // secondary line) should still NOT appear on Scribe rows — the
    // `proto-meta-secondary` testid is scoped to agent === 'proto'.
    const msg = {
      type: 'agent',
      agent: 'scribe',
      content: 'Spec hazırlanıyor',
      summary: 'Scribe özeti burada',
      totalFiles: 7,
      timestamp: TS,
    } as unknown as ChatMessageType;
    render(<ChatMessage message={msg} />);
    expect(screen.getByText('Scribe özeti burada')).toBeInTheDocument();
    expect(screen.queryByTestId('proto-meta-secondary')).not.toBeInTheDocument();
  });

  it('copy button copies the summary text when summary is present', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: 'Scaffold oluşturuldu — 15 dosya',
      summary: 'Sayaç için React projesi hazırladım.',
      totalFiles: 15,
      timestamp: TS,
    };
    render(<ChatMessage message={msg} />);
    fireEvent.click(screen.getByTitle('Kopyala'));
    expect(writeText).toHaveBeenCalledWith('Sayaç için React projesi hazırladım.');
  });
});

// ─── 11. agent_started message — Critic filter (PR-F1) ─────────────────────

describe('ChatMessage — agent_started (PR-F1 critic filter)', () => {
  it('renders Scribe/Proto/Trace agent_started rows', () => {
    const scribeMsg = {
      type: 'agent_started',
      agent: 'scribe',
      task: 'pipeline.activity.scribe.writing_spec',
      state: 'running',
      timestamp: TS,
    } as ChatMessageType;
    const { container } = render(<ChatMessage message={scribeMsg} />);
    // The wrapper div from ChatMessage exists (non-null first child).
    expect(container.firstElementChild).not.toBeNull();
    expect(screen.getByText('Scribe')).toBeInTheDocument();
  });

  it('PR-F1: returns null for agent="critic" (background guardrail)', () => {
    // Defensive guard — AgentName type currently excludes 'critic' but a future
    // refactor could widen it; this test pins the modern-stack invariant that
    // Critic events do NOT appear as chat rows. The user finding (image #40)
    // showed "Critic Spesifikasyon inceleniyor (adversarial review)..." in
    // the chat flow; the cast below simulates that leak.
    const criticLeak = {
      type: 'agent_started',
      agent: 'critic',
      task: 'Spesifikasyon inceleniyor...',
      state: 'running',
      timestamp: TS,
    } as unknown as ChatMessageType;
    const { container } = render(<ChatMessage message={criticLeak} />);
    expect(container.firstElementChild).toBeNull();
  });
});
