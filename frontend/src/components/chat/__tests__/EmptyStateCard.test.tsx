import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyStateCard } from '../EmptyStateCard';
import { DEMO_PROJECTS } from '../demoProjects';

// Identity-translator so we can assert on i18n keys directly. Demo idea text
// comes through the same `t()`, so onDemoSelect receives the *ideaKey* (e.g.
// "chat.empty.demo.todo.idea") — that's enough to verify the wiring.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    setLocale: vi.fn(),
  }),
}));

describe('EmptyStateCard', () => {
  it('renders title, description, every demo button and the manual-start button', () => {
    render(<EmptyStateCard onDemoSelect={vi.fn()} onManualStart={vi.fn()} />);

    expect(screen.getByText('chat.empty.title')).toBeInTheDocument();
    expect(screen.getByText('chat.empty.description')).toBeInTheDocument();

    for (const demo of DEMO_PROJECTS) {
      expect(screen.getByTestId(`empty-state-demo-${demo.id}`)).toBeInTheDocument();
      expect(screen.getByText(demo.labelKey)).toBeInTheDocument();
    }

    expect(screen.getByTestId('empty-state-manual-start')).toBeInTheDocument();
    expect(screen.getByText('chat.empty.manualStart')).toBeInTheDocument();
  });

  it('renders exactly four demo buttons', () => {
    render(<EmptyStateCard onDemoSelect={vi.fn()} onManualStart={vi.fn()} />);

    const demoButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid')?.startsWith('empty-state-demo-'));
    expect(demoButtons).toHaveLength(4);
  });

  it('fires onDemoSelect with the resolved idea text when a demo is clicked', () => {
    const onDemoSelect = vi.fn();
    render(<EmptyStateCard onDemoSelect={onDemoSelect} onManualStart={vi.fn()} />);

    fireEvent.click(screen.getByTestId('empty-state-demo-todo'));
    expect(onDemoSelect).toHaveBeenCalledTimes(1);
    expect(onDemoSelect).toHaveBeenCalledWith('chat.empty.demo.todo.idea');

    fireEvent.click(screen.getByTestId('empty-state-demo-currency'));
    expect(onDemoSelect).toHaveBeenLastCalledWith('chat.empty.demo.currency.idea');
  });

  it('fires onManualStart when the manual-start button is clicked', () => {
    const onManualStart = vi.fn();
    render(<EmptyStateCard onDemoSelect={vi.fn()} onManualStart={onManualStart} />);

    fireEvent.click(screen.getByTestId('empty-state-manual-start'));
    expect(onManualStart).toHaveBeenCalledTimes(1);
  });
});
