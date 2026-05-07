import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfidenceBadge } from '../ConfidenceBadge';

describe('ConfidenceBadge', () => {
  it('renders high tier when score >= 85', () => {
    render(<ConfidenceBadge score={92} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('data-tier', 'high');
    expect(btn).toHaveTextContent('92%');
    expect(btn).toHaveTextContent('Yüksek güven');
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
    expect(btn).not.toHaveTextContent('Yüksek güven');
  });

  it('toggles tooltip on click and shows factors', () => {
    render(<ConfidenceBadge score={90} factors={['Faktör 1', 'Faktör 2']} />);
    const btn = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(btn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Faktör 1');
    expect(tooltip).toHaveTextContent('Faktör 2');
  });

  it('exposes ARIA label with tier and score', () => {
    render(<ConfidenceBadge score={88} />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Yüksek güven: 88%',
    );
  });

  it('does not enable tooltip cursor when no factors provided', () => {
    render(<ConfidenceBadge score={88} />);
    expect(screen.getByRole('button')).not.toHaveClass('cursor-help');
  });
});
