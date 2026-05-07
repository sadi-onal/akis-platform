import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttentionBanner } from '../AttentionBanner';
import type { AttentionPoint } from '../../../types/pipeline';

const mk = (severity: AttentionPoint['severity'], stage: string, issue: string): AttentionPoint => ({
  severity,
  stage,
  issue,
});

describe('AttentionBanner', () => {
  it('renders nothing when no points', () => {
    const { container } = render(<AttentionBanner points={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('sorts by severity (high → medium → low)', () => {
    render(
      <AttentionBanner
        points={[
          mk('low', 'trace', 'Risk'),
          mk('high', 'critic', 'Critical issue'),
          mk('medium', 'scribe', 'Medium issue'),
        ]}
      />,
    );
    const items = screen.getAllByRole('status');
    expect(items[0]).toHaveAttribute('data-severity', 'high');
    expect(items[1]).toHaveAttribute('data-severity', 'medium');
    expect(items[2]).toHaveAttribute('data-severity', 'low');
  });

  it('caps at limit and shows overflow note', () => {
    const points = Array.from({ length: 6 }, (_, i) =>
      mk('medium', 'scribe', `Issue ${i}`),
    );
    render(<AttentionBanner points={points} limit={3} />);
    const items = screen.getAllByRole('status');
    expect(items.length).toBe(3);
    expect(screen.getByText(/3 ek dikkat noktası gizlendi/)).toBeInTheDocument();
  });

  it('omits overflow note when within limit', () => {
    render(<AttentionBanner points={[mk('high', 'critic', 'Test')]} limit={3} />);
    expect(screen.queryByText(/ek dikkat noktası/)).toBeNull();
  });

  it('uses Turkish severity labels', () => {
    render(
      <AttentionBanner
        points={[mk('high', 'a', 'x'), mk('medium', 'b', 'y'), mk('low', 'c', 'z')]}
      />,
    );
    expect(screen.getByText('Önemli')).toBeInTheDocument();
    expect(screen.getByText('Dikkat')).toBeInTheDocument();
    expect(screen.getByText('Bilgi')).toBeInTheDocument();
  });

  it('renders the issue text and stage', () => {
    render(<AttentionBanner points={[mk('high', 'critic', 'XSS açığı')]} />);
    expect(screen.getByText('XSS açığı')).toBeInTheDocument();
    expect(screen.getByText('critic')).toBeInTheDocument();
  });
});
