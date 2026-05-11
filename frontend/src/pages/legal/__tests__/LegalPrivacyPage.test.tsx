/**
 * LegalPrivacyPage — smoke + content tests
 *
 * Covers:
 *  - Renders the page header (label + title)
 *  - Renders the last-updated paragraph
 *  - Renders the introduction card
 *  - Renders all 5 privacy sections (collection, use, sharing, security, rights)
 *  - Renders the privacy contact mailto link
 *
 * Strategy: mock useI18n to echo translation keys back so we can assert
 * on stable strings independent of locale catalogue contents.
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

import LegalPrivacyPage from '../LegalPrivacyPage';

describe('LegalPrivacyPage', () => {
  it('renders the header label and h1 title', () => {
    render(<LegalPrivacyPage />);
    expect(screen.getByText('privacy.label')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1, name: 'privacy.title' });
    expect(heading).toBeInTheDocument();
  });

  it('renders the last-updated paragraph', () => {
    render(<LegalPrivacyPage />);
    expect(screen.getByText('privacy.lastUpdated')).toBeInTheDocument();
  });

  it('renders the intro card paragraph', () => {
    render(<LegalPrivacyPage />);
    expect(screen.getByText('privacy.intro')).toBeInTheDocument();
  });

  it('renders all five section titles and contents', () => {
    render(<LegalPrivacyPage />);

    const sectionKeys = [
      'privacy.collection',
      'privacy.use',
      'privacy.sharing',
      'privacy.security',
      'privacy.rights',
    ];

    for (const base of sectionKeys) {
      expect(screen.getByText(`${base}.title`)).toBeInTheDocument();
      expect(screen.getByText(`${base}.content`)).toBeInTheDocument();
    }

    // Sanity: every section title should be an h2 (the sections map renders one card each).
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s).toHaveLength(sectionKeys.length);
  });

  it('renders the privacy mailto link', () => {
    render(<LegalPrivacyPage />);
    const link = screen.getByRole('link', { name: 'privacy@akis.dev' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'mailto:privacy@akis.dev');
  });
});
