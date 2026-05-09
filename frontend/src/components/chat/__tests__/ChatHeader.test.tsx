import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatHeader } from '../ChatHeader';

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
    expect(screen.getByText('ask')).toBeInTheDocument();
  });

  it('renders plan mode badge', () => {
    render(<ChatHeader {...baseProps} mode="plan" />);
    expect(screen.getByText('plan')).toBeInTheDocument();
  });

  it('renders act mode badge', () => {
    render(<ChatHeader {...baseProps} mode="act" />);
    expect(screen.getByText('act')).toBeInTheDocument();
  });

  it('renders review mode badge', () => {
    render(<ChatHeader {...baseProps} mode="review" />);
    expect(screen.getByText('review')).toBeInTheDocument();
  });

  // F-05: bakkal-language tooltip per mode (see docs/product/02-ux § 6 + 05-findings F-05).
  // Each mode badge must carry a jargon-free Türkçe açıklama as `title` + `aria-label`.
  it('ASK mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="ask" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Sorularını yanıtlıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Sorularını yanıtlıyoruz');
    expect(badge).toHaveTextContent('ask');
  });

  it('PLAN mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="plan" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Yapılacakları planlıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Yapılacakları planlıyoruz');
    expect(badge).toHaveTextContent('plan');
  });

  it('ACT mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="act" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Kodu yazıyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Kodu yazıyoruz');
    expect(badge).toHaveTextContent('act');
  });

  it('REVIEW mode badge carries bakkal-language tooltip', () => {
    render(<ChatHeader {...baseProps} mode="review" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('title', 'Sonucu birlikte gözden geçiriyoruz');
    expect(badge).toHaveAttribute('aria-label', 'Sonucu birlikte gözden geçiriyoruz');
    expect(badge).toHaveTextContent('review');
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
      />,
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
    expect(screen.getByLabelText('Preview aç')).toBeInTheDocument();
  });

  it('shows "Preview kapat" label when preview is shown', () => {
    render(<ChatHeader {...baseProps} hasPreview showPreview onTogglePreview={vi.fn()} />);
    expect(screen.getByLabelText('Preview kapat')).toBeInTheDocument();
  });

  it('calls onTogglePreview when preview button clicked', () => {
    const onToggle = vi.fn();
    render(<ChatHeader {...baseProps} hasPreview showPreview={false} onTogglePreview={onToggle} />);
    fireEvent.click(screen.getByLabelText('Preview aç'));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
