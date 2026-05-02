import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from '../EmptyState';

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../onboarding/AgentFeatureCard', () => ({
  AgentFeatureCard: ({ title }: { title: string }) => <div data-testid={`agent-${title}`}>{title}</div>,
}));

describe('EmptyState', () => {
  describe('new-conversation variant', () => {
    it('shows greeting text', () => {
      render(<EmptyState variant="new-conversation" />);
      expect(screen.getByText(/chat\.emptyState\.greeting/)).toBeInTheDocument();
      expect(screen.getByText('chat.emptyState.brandName')).toBeInTheDocument();
    });

    it('shows agent badges Scribe, Proto, and Trace', () => {
      render(<EmptyState variant="new-conversation" />);
      expect(screen.getByText('Scribe')).toBeInTheDocument();
      expect(screen.getByText('Proto')).toBeInTheDocument();
      expect(screen.getByText('Trace')).toBeInTheDocument();
    });

    it('does not show the CTA button', () => {
      render(<EmptyState variant="new-conversation" />);
      expect(screen.queryByRole('button', { name: /chat\.emptyState\.newChat/i })).not.toBeInTheDocument();
    });
  });

  describe('no-conversation variant', () => {
    it('shows the CTA button', () => {
      render(<EmptyState variant="no-conversation" onNewConversation={vi.fn()} />);
      expect(screen.getByRole('button', { name: /chat\.emptyState\.newChat/i })).toBeInTheDocument();
    });

    it('calls onNewConversation when CTA button is clicked', () => {
      const onNewConversation = vi.fn();
      render(<EmptyState variant="no-conversation" onNewConversation={onNewConversation} />);
      fireEvent.click(screen.getByRole('button', { name: /chat\.emptyState\.newChat/i }));
      expect(onNewConversation).toHaveBeenCalledOnce();
    });

    it('shows agent feature cards for Scribe, Proto, and Trace', () => {
      render(<EmptyState variant="no-conversation" onNewConversation={vi.fn()} />);
      expect(screen.getByTestId('agent-Scribe')).toBeInTheDocument();
      expect(screen.getByTestId('agent-Proto')).toBeInTheDocument();
      expect(screen.getByTestId('agent-Trace')).toBeInTheDocument();
    });
  });
});
