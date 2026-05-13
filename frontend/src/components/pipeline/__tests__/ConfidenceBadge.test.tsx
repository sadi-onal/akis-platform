import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub useI18n so assertions can match the i18n keys directly (same pattern as
// AgentStartedLine + other i18n-migrated component tests).
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { ConfidenceBadge } from '../ConfidenceBadge';

describe('ConfidenceBadge', () => {
  it('renders high tier when score >= 85', () => {
    render(<ConfidenceBadge score={92} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-tier', 'high');
    expect(btn).toHaveTextContent('92%');
    expect(btn).toHaveTextContent('confidence.tier.high');
  });

  it('renders medium tier when 70 <= score < 85', () => {
    render(<ConfidenceBadge score={75} />);
    expect(screen.getByRole('button')).toHaveAttribute('data-tier', 'medium');
  });

  it('renders low tier when score < 70', () => {
    render(<ConfidenceBadge score={55} />);
    expect(screen.getByRole('button')).toHaveAttribute('data-tier', 'low');
  });

  it('clamps scores below 0 to 0', () => {
    render(<ConfidenceBadge score={-10} />);
    expect(screen.getByRole('button')).toHaveTextContent('0%');
  });

  it('clamps scores above 100 to 100', () => {
    render(<ConfidenceBadge score={150} />);
    expect(screen.getByRole('button')).toHaveTextContent('100%');
  });

  it('rounds fractional scores', () => {
    render(<ConfidenceBadge score={87.6} />);
    expect(screen.getByRole('button')).toHaveTextContent('88%');
  });

  it('renders compact form without label when compact=true', () => {
    render(<ConfidenceBadge score={88} compact />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('88%');
    expect(btn).not.toHaveTextContent('confidence.tier.high');
  });

  it('toggles tooltip on click and shows factors when provided', () => {
    render(<ConfidenceBadge score={90} factors={['Faktör 1', 'Faktör 2']} />);
    const btn = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(btn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('confidence.tooltip.factorsHeader');
    expect(tooltip).toHaveTextContent('Faktör 1');
    expect(tooltip).toHaveTextContent('Faktör 2');
  });

  it('exposes ARIA label with tier and score', () => {
    render(<ConfidenceBadge score={88} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'confidence.tier.high: 88%');
  });

  // Bulgu G — tooltip now ALWAYS opens on hover/click so bakkal users get an
  // explanation of what the score actually means, not just a bare number.
  it('opens tooltip even without factors and shows tier explanation', () => {
    render(<ConfidenceBadge score={92} />);
    const btn = screen.getByRole('button');
    fireEvent.mouseEnter(btn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('confidence.tooltip.scoreCaption');
    expect(tooltip).toHaveTextContent('confidence.explanation.high');
    expect(tooltip).not.toHaveTextContent('confidence.tooltip.factorsHeader');
  });

  it('surfaces the medium-tier explanation in the tooltip', () => {
    render(<ConfidenceBadge score={75} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('confidence.explanation.medium');
  });

  it('surfaces the low-tier explanation in the tooltip', () => {
    render(<ConfidenceBadge score={55} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('confidence.explanation.low');
  });

  it('shows cursor-help affordance whether or not factors are present', () => {
    render(<ConfidenceBadge score={88} />);
    expect(screen.getByRole('button')).toHaveClass('cursor-help');
  });

  // Bulgu G follow-up — accessibility + viewport-safety review feedback.
  it('dismisses the tooltip when Escape is pressed', () => {
    render(<ConfidenceBadge score={92} />);
    const btn = screen.getByRole('button');
    fireEvent.mouseEnter(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('anchors the tooltip to the right edge (prevents column-overflow)', () => {
    render(<ConfidenceBadge score={88} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.className).toMatch(/\bright-0\b/);
    expect(tooltip.className).not.toMatch(/\bleft-0\b/);
  });
});
