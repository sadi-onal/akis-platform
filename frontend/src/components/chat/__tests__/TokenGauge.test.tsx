import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TokenGauge } from '../TokenGauge';
import { formatTokens } from '../../../utils/formatTokens';
import type { WorkflowTokenUsage } from '../../../types/workflow';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

function usage(overrides: Partial<WorkflowTokenUsage> = {}): WorkflowTokenUsage {
  return {
    inputTokens: 8_000,
    outputTokens: 4_000,
    totalTokens: 12_000,
    contextWindow: 200_000,
    percentUsed: 6.0,
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

describe('TokenGauge', () => {
  it('renders tokens formatted + percent label', () => {
    render(<TokenGauge usage={usage()} />);
    expect(screen.getByText(/12\.0k \/ 200\.0k · %6\.00/)).toBeInTheDocument();
  });

  it('uses ok styling below 80%', () => {
    const { container } = render(<TokenGauge usage={usage({ percentUsed: 50 })} />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('border-ak-border');
    expect(button?.className).not.toContain('amber');
    expect(button?.className).not.toContain('red');
  });

  it('uses warn (amber) styling at 80%+', () => {
    const { container } = render(<TokenGauge usage={usage({ percentUsed: 82.5 })} />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('amber');
    expect(button?.className).not.toContain('red-500');
  });

  it('uses critical (red) styling at 95%+', () => {
    const { container } = render(<TokenGauge usage={usage({ percentUsed: 97.2 })} />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('red');
  });

  it('reveals tooltip on mouse enter and hides on leave', () => {
    const { container } = render(<TokenGauge usage={usage()} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('chat.tokens.tooltip.input')).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows high warning when severity is warn', () => {
    const { container } = render(<TokenGauge usage={usage({ percentUsed: 85 })} />);
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    expect(screen.getByText('chat.tokens.warning.high')).toBeInTheDocument();
    expect(screen.queryByText('chat.tokens.warning.critical')).not.toBeInTheDocument();
  });

  it('shows critical warning when severity is critical', () => {
    const { container } = render(<TokenGauge usage={usage({ percentUsed: 98 })} />);
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    expect(screen.getByText('chat.tokens.warning.critical')).toBeInTheDocument();
  });
});

describe('formatTokens', () => {
  it('handles small numbers literally', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(999_999)).toBe('1000.0k');
  });

  it('formats millions with M suffix (1M+ context window case)', () => {
    expect(formatTokens(1_047_576)).toBe('1.05M');
    expect(formatTokens(2_000_000)).toBe('2.00M');
  });

  it('handles negative / NaN as 0', () => {
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });
});
