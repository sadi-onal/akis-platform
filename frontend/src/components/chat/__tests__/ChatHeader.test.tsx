import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '../ChatHeader';

// F-05: ChatHeader now reads tooltip strings from the i18n catalogue
// (`chat.modeBadge.*` in `frontend/src/i18n/locales/{tr,en}.json`).
// Stub mirrors the TR catalogue so the existing assertions stay grounded
// on real user-facing copy and a future locale-key rename trips the test.
const TR_MODE_BADGE_MESSAGES: Record<string, string> = {
  'chat.modeBadge.ask': 'Sorularını yanıtlıyoruz',
  'chat.modeBadge.plan': 'Yapılacakları planlıyoruz',
  'chat.modeBadge.act': 'Kodu yazıyoruz',
  'chat.modeBadge.review': 'Sonucu birlikte gözden geçiriyoruz',
  'chat.modeBadge.failed.title': 'Bir sorun çıktı: detaylar için sohbeti inceleyin',
  'chat.modeBadge.failed.aria': 'Bir sorun çıktı',
  // PR-T2: short chip-friendly labels (visible text).
  'chat.modeBadge.label.ask': 'Soru',
  'chat.modeBadge.label.plan': 'Plan',
  'chat.modeBadge.label.act': 'Yapım',
  'chat.modeBadge.label.review': 'İnceleme',
  'chat.header.preview': 'Önizleme',
};

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => TR_MODE_BADGE_MESSAGES[key] ?? key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

describe('ChatHeader', () => {
  const baseProps = {
    repoShortName: 'todo-app',
    repoFullName: 'testuser/todo-app',
  };

  it('renders repo short name', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.getByText('todo-app')).toBeInTheDocument();
  });

  it('renders repo full name', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.getByText('testuser/todo-app')).toBeInTheDocument();
  });

  it('renders repo full name as link when repoUrl provided', () => {
    render(<ChatHeader {...baseProps} repoUrl="https://github.com/testuser/todo-app" />);
    const link = screen.getByText('testuser/todo-app').closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/testuser/todo-app');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders mode badge with correct text', () => {
    render(<ChatHeader {...baseProps} mode="ask" />);
    expect(screen.getByTestId('chat-mode-badge')).toHaveTextContent('Soru');
  });

  it('renders plan mode badge', () => {
    render(<ChatHeader {...baseProps} mode="plan" />);
    expect(screen.getByTestId('chat-mode-badge')).toHaveTextContent('Plan');
  });

  it('renders act mode badge', () => {
    render(<ChatHeader {...baseProps} mode="act" />);
    expect(screen.getByTestId('chat-mode-badge')).toHaveTextContent('Yapım');
  });

  it('renders review mode badge', () => {
    render(<ChatHeader {...baseProps} mode="review" />);
    expect(screen.getByTestId('chat-mode-badge')).toHaveTextContent('İnceleme');
  });

  // F-05: bakkal-language tooltip per mode (see docs/product/02-ux § 6 + 05-findings F-05).
  // Each mode badge must carry a jargon-free Türkçe açıklama as `title` + `aria-label`.
  it('ASK mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="ask" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Sorularını yanıtlıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Sorularını yanıtlıyoruz');
    expect(badge).toHaveTextContent('Soru');
  });

  it('PLAN mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="plan" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Yapılacakları planlıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Yapılacakları planlıyoruz');
    expect(badge).toHaveTextContent('Plan');
  });

  it('ACT mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="act" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Kodu yazıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Kodu yazıyoruz');
    expect(badge).toHaveTextContent('Yapım');
  });

  it('REVIEW mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="review" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Sonucu birlikte gözden geçiriyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Sonucu birlikte gözden geçiriyoruz');
    expect(badge).toHaveTextContent('İnceleme');
  });

  // F-05: HATA badge overrides mode when isFailed=true. Tooltip uses the
  // longer call-to-action ("detaylar için sohbeti inceleyin"); aria-label
  // intentionally stays compact for screen readers.
  it('HATA badge carries bakkal-language tooltip when isFailed', () => {
    render(<ChatHeader {...baseProps} mode="ask" isFailed />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Bir sorun çıktı: detaylar için sohbeti inceleyin');
    expect(badge).toHaveAttribute('aria-label', 'Bir sorun çıktı');
    expect(badge).toHaveTextContent('HATA');
  });

  it('does not render mode badge when mode is undefined', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.queryByText('ask')).not.toBeInTheDocument();
    expect(screen.queryByText('plan')).not.toBeInTheDocument();
  });

  it('renders branch name', () => {
    render(<ChatHeader {...baseProps} branch="feat/auth" />);
    expect(screen.getByText('feat/auth')).toBeInTheDocument();
  });

  it('does not render branch when not provided', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('renders PR link with number', () => {
    render(
      <ChatHeader
        {...baseProps}
        prUrl="https://github.com/testuser/todo-app/pull/42"
        prNumber={42}
      />
    );
    expect(screen.getByText('PR #42')).toBeInTheDocument();
    const prLink = screen.getByText('PR #42').closest('a');
    expect(prLink).toHaveAttribute('href', 'https://github.com/testuser/todo-app/pull/42');
  });

  it('does not render PR link when not provided', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
  });

  it('renders back button when showBackButton is true', () => {
    const onBack = vi.fn();
    render(<ChatHeader {...baseProps} showBackButton onBack={onBack} />);
    const backBtn = screen.getByLabelText('Geri');
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('does not render back button by default', () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.queryByLabelText('Geri')).not.toBeInTheDocument();
  });

  it('renders preview toggle when hasPreview is true', () => {
    render(<ChatHeader {...baseProps} hasPreview showPreview={false} onTogglePreview={vi.fn()} />);
    const button = screen.getByLabelText('Önizleme');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('preview button is aria-pressed when showPreview is true', () => {
    render(<ChatHeader {...baseProps} hasPreview showPreview onTogglePreview={vi.fn()} />);
    expect(screen.getByLabelText('Önizleme')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onTogglePreview when preview button clicked', () => {
    const onToggle = vi.fn();
    render(<ChatHeader {...baseProps} hasPreview showPreview={false} onTogglePreview={onToggle} />);
    fireEvent.click(screen.getByLabelText('Önizleme'));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
