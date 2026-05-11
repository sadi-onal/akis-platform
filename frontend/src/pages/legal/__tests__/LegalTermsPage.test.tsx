/**
 * LegalTermsPage — smoke + content tests
 *
 * Covers:
 *  - Renders the header label + h1 title
 *  - Renders the last-updated paragraph
 *  - Renders the introduction card
 *  - Renders all 6 terms sections (service, account, usage, intellectual,
 *    liability, changes)
 *  - Renders the legal mailto link
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    availableLocales: ['en', 'tr'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import LegalTermsPage from '../LegalTermsPage';

describe('LegalTermsPage', () => {
  it('renders the header label and h1 title', () => {
    render(<LegalTermsPage />);
    expect(screen.getByText('terms.label')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'terms.title' }),
    ).toBeInTheDocument();
  });

  it('renders the last-updated paragraph', () => {
    render(<LegalTermsPage />);
    expect(screen.getByText('terms.lastUpdated')).toBeInTheDocument();
  });

  it('renders the intro card paragraph', () => {
    render(<LegalTermsPage />);
    expect(screen.getByText('terms.intro')).toBeInTheDocument();
  });

  it('renders all six section titles and contents', () => {
    render(<LegalTermsPage />);

    const sectionKeys = [
      'terms.service',
      'terms.account',
      'terms.usage',
      'terms.intellectual',
      'terms.liability',
      'terms.changes',
    ];

    for (const base of sectionKeys) {
      expect(screen.getByText(`${base}.title`)).toBeInTheDocument();
      expect(screen.getByText(`${base}.content`)).toBeInTheDocument();
    }

    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s).toHaveLength(sectionKeys.length);
  });

  it('renders the legal mailto link', () => {
    render(<LegalTermsPage />);
    const link = screen.getByRole('link', { name: 'legal@akis.dev' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'mailto:legal@akis.dev');
  });
});
