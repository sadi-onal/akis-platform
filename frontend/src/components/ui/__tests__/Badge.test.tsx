import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, StatusBadge } from '../Badge';

describe('Badge', () => {
  const states = ['pending', 'running', 'completed', 'failed', 'awaiting_approval'] as const;
  const expectedLabels: Record<string, string> = {
    pending: 'Bekliyor',
    running: 'Calisiyor',
    completed: 'Tamamlandi',
    failed: 'Basarisiz',
    awaiting_approval: 'Onay Bekliyor',
  };

  for (const state of states) {
    it(`renders "${expectedLabels[state]}" label for state "${state}"`, () => {
      render(<Badge state={state} />);
      expect(screen.getByText(expectedLabels[state])).toBeInTheDocument();
    });
  }

  it('renders a status dot indicator', () => {
    const { container } = render(<Badge state="running" />);
    const dot = container.querySelector('[aria-hidden]');
    expect(dot).toBeInTheDocument();
  });

  it('applies animate-pulse class for running state', () => {
    const { container } = render(<Badge state="running" />);
    const dot = container.querySelector('[aria-hidden]');
    expect(dot?.className).toContain('animate-pulse');
  });
});

describe('StatusBadge', () => {
  it('renders children text', () => {
    render(<StatusBadge>Active</StatusBadge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('defaults to neutral variant', () => {
    const { container } = render(<StatusBadge>Test</StatusBadge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-ak-surface-2');
  });

  it('applies success variant styles', () => {
    const { container } = render(<StatusBadge variant="success">OK</StatusBadge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-green-500/10');
  });

  it('applies error variant styles', () => {
    const { container } = render(<StatusBadge variant="error">Fail</StatusBadge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-red-500/10');
  });

  it('accepts custom className', () => {
    const { container } = render(<StatusBadge className="my-custom">Test</StatusBadge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('my-custom');
  });
});
