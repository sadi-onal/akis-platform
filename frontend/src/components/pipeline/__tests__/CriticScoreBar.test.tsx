/**
 * P8 — CriticScoreBar tests.
 *
 * Covers:
 *   - Renders score (X/100) and findings count
 *   - Threshold line is positioned at the configured value (default 75)
 *   - Approved status pill shows when score >= threshold (green/emerald)
 *   - Blocked status pill shows when score < threshold (rose)
 *   - Score < 0 / > 100 / negative thresholds are clamped to [0, 100]
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CriticScoreBar } from '../CriticScoreBar';

const TR_STUBS: Record<string, string> = {
  'chat.critic.scoreBar.title': 'Kod inceleme skoru',
  'chat.critic.scoreBar.threshold': 'Onay eşiği: {value}',
  'chat.critic.scoreBar.approved': 'Onaylandı',
  'chat.critic.scoreBar.blocked': 'Düzeltme bekleniyor',
  'chat.critic.scoreBar.findingsSuffix': 'bulgu',
};

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => TR_STUBS[key] ?? key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

describe('CriticScoreBar', () => {
  it('renders score / 100 + findings suffix', () => {
    render(<CriticScoreBar score={62} threshold={75} findingsCount={3} />);
    expect(screen.getByText(/62\/100/)).toBeInTheDocument();
    expect(screen.getByText(/3 bulgu/)).toBeInTheDocument();
  });

  it('shows the threshold value in the caption', () => {
    render(<CriticScoreBar score={70} threshold={80} findingsCount={1} />);
    expect(screen.getByText(/Onay eşiği: 80/)).toBeInTheDocument();
  });

  it('renders the blocked status pill when score < threshold', () => {
    render(<CriticScoreBar score={50} threshold={75} findingsCount={2} />);
    const status = screen.getByTestId('critic-score-bar-status');
    expect(status).toHaveTextContent(/Düzeltme bekleniyor/);
    const bar = screen.getByTestId('critic-score-bar');
    expect(bar.getAttribute('data-approved')).toBe('false');
  });

  it('renders the approved status pill when score >= threshold', () => {
    render(<CriticScoreBar score={85} threshold={75} findingsCount={1} />);
    const status = screen.getByTestId('critic-score-bar-status');
    expect(status).toHaveTextContent(/Onaylandı/);
    const bar = screen.getByTestId('critic-score-bar');
    expect(bar.getAttribute('data-approved')).toBe('true');
  });

  it('clamps score to [0, 100] for display + dataset', () => {
    const { rerender } = render(<CriticScoreBar score={150} threshold={75} findingsCount={0} />);
    expect(screen.getByTestId('critic-score-bar').getAttribute('data-score')).toBe('100');

    rerender(<CriticScoreBar score={-20} threshold={75} findingsCount={0} />);
    expect(screen.getByTestId('critic-score-bar').getAttribute('data-score')).toBe('0');
  });

  it('defaults threshold to 75 when omitted', () => {
    render(<CriticScoreBar score={70} findingsCount={1} />);
    expect(screen.getByTestId('critic-score-bar').getAttribute('data-threshold')).toBe('75');
    // 70 < 75 → blocked
    expect(screen.getByTestId('critic-score-bar-status')).toHaveTextContent(/Düzeltme bekleniyor/);
  });

  it('positions the threshold marker at the threshold percent', () => {
    render(<CriticScoreBar score={40} threshold={60} findingsCount={1} />);
    const marker = screen.getByTestId('critic-score-bar-threshold');
    expect(marker.style.left).toBe('60%');
  });
});
