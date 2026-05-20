import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AttentionBanner } from '../AttentionBanner';
import type { AttentionPoint } from '../../../types/pipeline';

const mk = (
  severity: AttentionPoint['severity'],
  stage: string,
  issue: string
): AttentionPoint => ({
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
      />
    );
    const items = screen.getAllByRole('status');
    expect(items[0]).toHaveAttribute('data-severity', 'high');
    expect(items[1]).toHaveAttribute('data-severity', 'medium');
    expect(items[2]).toHaveAttribute('data-severity', 'low');
  });

  it('caps at limit and shows overflow toggle button', () => {
    const points = Array.from({ length: 6 }, (_, i) => mk('medium', 'scribe', `Issue ${i}`));
    render(<AttentionBanner points={points} limit={3} />);
    const items = screen.getAllByRole('status');
    expect(items.length).toBe(3);
    const toggle = screen.getByRole('button', { name: /3 ek dikkat noktası göster/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('omits overflow toggle when within limit', () => {
    render(<AttentionBanner points={[mk('high', 'critic', 'Test')]} limit={3} />);
    expect(screen.queryByText(/ek dikkat noktası/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('expands to show all points when toggle clicked and collapses on second click', () => {
    const points = Array.from({ length: 6 }, (_, i) => mk('medium', 'scribe', `Issue ${i}`));
    render(<AttentionBanner points={points} limit={3} />);
    expect(screen.getAllByRole('status').length).toBe(3);

    const toggle = screen.getByRole('button', { name: /göster/ });
    fireEvent.click(toggle);

    expect(screen.getAllByRole('status').length).toBe(6);
    const gizle = screen.getByRole('button', { name: /Gizle/ });
    expect(gizle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(gizle);
    expect(screen.getAllByRole('status').length).toBe(3);
    expect(screen.getByRole('button', { name: /göster/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('uses Turkish severity labels', () => {
    render(
      <AttentionBanner
        points={[mk('high', 'a', 'x'), mk('medium', 'b', 'y'), mk('low', 'c', 'z')]}
      />
    );
    expect(screen.getByText('Önemli')).toBeInTheDocument();
    expect(screen.getByText('Dikkat')).toBeInTheDocument();
    expect(screen.getByText('Bilgi')).toBeInTheDocument();
  });

  // T5: display-only rename — Critic → Değerlendirme
  it('renders the issue text and stage', () => {
    render(<AttentionBanner points={[mk('high', 'critic', 'XSS açığı')]} />);
    expect(screen.getByText('XSS açığı')).toBeInTheDocument();
    expect(screen.getByText('Değerlendirme')).toBeInTheDocument();
  });

  it('renders the granular critic stage label (spec vs kod)', () => {
    render(
      <AttentionBanner
        points={[
          mk('high', 'critic-spec', 'Spec netleştirilmeli'),
          mk('medium', 'critic-code', 'Kod kapsama düşük'),
        ]}
      />
    );
    expect(screen.getByText('Değerlendirme · spec')).toBeInTheDocument();
    expect(screen.getByText('Değerlendirme · kod')).toBeInTheDocument();
  });
});
