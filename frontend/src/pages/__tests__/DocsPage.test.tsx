/**
 * DocsPage — documentation page tests
 *
 * Covers:
 *  - Basic rendering (header, nav, sidebar, content area)
 *  - All five section titles present in sidebar navigation
 *  - Section switching via sidebar buttons
 *  - Section switching via mobile select dropdown
 *  - Markdown rendering (headings, paragraphs, list items, code blocks)
 *  - Accessibility (aria-label on mobile select, heading hierarchy)
 *  - Navigation buttons (logo → home, login button)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ──────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Translations: return the key for simple labels, return realistic content
// for section content to test the markdown renderer.
const MOCK_TRANSLATIONS: Record<string, string> = {
  'docsPage.nav.login': 'Sign In',
  'docsPage.nav.docsLabel': 'Docs',
  'docsPage.sections.gettingStarted.title': 'Getting Started',
  'docsPage.sections.gettingStarted.content':
    '## Welcome\nThis is the getting started guide.\n- Step one\n- Step two\n1. First\n2. Second\n\n`npm install akis`\n### Sub Heading',
  'docsPage.sections.pipeline.title': 'Pipeline Flow',
  'docsPage.sections.pipeline.content': '## Pipeline\nScribe then Proto then Trace.',
  'docsPage.sections.providers.title': 'AI Providers',
  'docsPage.sections.providers.content': '## Providers\nAnthropic Claude (built-in). OpenAI coming soon.',
  'docsPage.sections.settings.title': 'Settings',
  'docsPage.sections.settings.content': '## Settings\nManage your API keys.',
  'docsPage.sections.faq.title': 'FAQ',
  'docsPage.sections.faq.content': '## FAQ\nCommon questions answered here.',
};

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => MOCK_TRANSLATIONS[key] ?? key,
    locale: 'en',
    availableLocales: ['en', 'tr'],
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../theme/brand', () => ({
  LOGO_MARK_SVG: '/mock-logo.svg',
}));

// ── Helpers ─────────────────────────────────────────

function renderDocsPage() {
  return render(
    <MemoryRouter initialEntries={['/docs']}>
      <DocsPage />
    </MemoryRouter>,
  );
}

// Lazy import so mocks are registered first
let DocsPage: typeof import('../DocsPage').default;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../DocsPage');
  DocsPage = mod.default;
});

// ── Rendering ───────────────────────────────────────

describe('DocsPage — rendering', () => {
  it('renders the AKIS brand logo', () => {
    renderDocsPage();
    const logo = screen.getByAltText('AKIS');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src', '/mock-logo.svg');
  });

  it('renders the AKIS brand text', () => {
    renderDocsPage();
    expect(screen.getByText('AKIS')).toBeInTheDocument();
  });

  it('renders the docs label next to the brand', () => {
    renderDocsPage();
    expect(screen.getByText('Docs')).toBeInTheDocument();
  });

  it('renders the Sign In button', () => {
    renderDocsPage();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('renders all five section titles in sidebar buttons', () => {
    renderDocsPage();
    const sectionTitles = ['Getting Started', 'Pipeline Flow', 'AI Providers', 'Settings', 'FAQ'];
    for (const title of sectionTitles) {
      // Each title appears in both sidebar button and mobile select option
      const buttons = screen.getAllByText(title);
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders the mobile section select dropdown', () => {
    renderDocsPage();
    const select = screen.getByLabelText('Bolum sec');
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe('SELECT');
  });

  it('renders all section options in the mobile select', () => {
    renderDocsPage();
    const select = screen.getByLabelText('Bolum sec');
    const options = within(select).getAllByRole('option');
    expect(options).toHaveLength(5);
    expect(options.map((o) => o.textContent)).toEqual([
      'Getting Started',
      'Pipeline Flow',
      'AI Providers',
      'Settings',
      'FAQ',
    ]);
  });
});

// ── Navigation ──────────────────────────────────────

describe('DocsPage — navigation', () => {
  it('navigates to home when clicking the AKIS logo', () => {
    renderDocsPage();
    const logoButton = screen.getByText('AKIS').closest('button')!;
    fireEvent.click(logoButton);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('navigates to login when clicking Sign In button', () => {
    renderDocsPage();
    fireEvent.click(screen.getByText('Sign In'));
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});

// ── Section switching ───────────────────────────────

describe('DocsPage — section switching', () => {
  it('shows Getting Started content by default', () => {
    renderDocsPage();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('This is the getting started guide.')).toBeInTheDocument();
  });

  it('switches section when clicking a sidebar button', () => {
    renderDocsPage();
    // Click on Pipeline Flow section
    const pipelineButtons = screen.getAllByText('Pipeline Flow');
    // Find the sidebar button (first one, since sidebar comes before select in DOM)
    fireEvent.click(pipelineButtons[0]);
    expect(screen.getByText('Scribe then Proto then Trace.')).toBeInTheDocument();
    // Previous section content should not be visible
    expect(screen.queryByText('This is the getting started guide.')).not.toBeInTheDocument();
  });

  it('switches section when changing mobile select', () => {
    renderDocsPage();
    const select = screen.getByLabelText('Bolum sec');
    fireEvent.change(select, { target: { value: 'faq' } });
    expect(screen.getByText('Common questions answered here.')).toBeInTheDocument();
  });

  it('can navigate through all sections via sidebar', () => {
    renderDocsPage();
    const sectionContentSnippets: Record<string, string> = {
      'Pipeline Flow': 'Scribe then Proto then Trace.',
      'AI Providers': 'Anthropic Claude (built-in). OpenAI coming soon.',
      Settings: 'Manage your API keys.',
      FAQ: 'Common questions answered here.',
    };

    for (const [title, snippet] of Object.entries(sectionContentSnippets)) {
      const buttons = screen.getAllByText(title);
      fireEvent.click(buttons[0]);
      expect(screen.getByText(snippet)).toBeInTheDocument();
    }
  });
});

// ── Markdown rendering ──────────────────────────────

describe('DocsPage — markdown rendering', () => {
  it('renders ## headings as <h2> elements', () => {
    renderDocsPage();
    const h2 = screen.getByText('Welcome');
    expect(h2.tagName).toBe('H2');
  });

  it('renders ### headings as <h3> elements', () => {
    renderDocsPage();
    const h3 = screen.getByText('Sub Heading');
    expect(h3.tagName).toBe('H3');
  });

  it('renders paragraph lines as <p> elements', () => {
    renderDocsPage();
    const para = screen.getByText('This is the getting started guide.');
    expect(para.tagName).toBe('P');
  });

  it('renders unordered list items (- prefix)', () => {
    renderDocsPage();
    const item = screen.getByText('Step one');
    expect(item.tagName).toBe('LI');
    expect(item.className).toContain('list-disc');
  });

  it('renders ordered list items (number. prefix)', () => {
    renderDocsPage();
    const item = screen.getByText('First');
    expect(item.tagName).toBe('LI');
    expect(item.className).toContain('list-decimal');
  });

  it('renders inline code blocks (`...`) as <code> elements', () => {
    renderDocsPage();
    const code = screen.getByText('npm install akis');
    expect(code.tagName).toBe('CODE');
  });
});

// ── Accessibility ───────────────────────────────────

describe('DocsPage — accessibility', () => {
  it('mobile select has an aria-label for screen readers', () => {
    renderDocsPage();
    const select = screen.getByLabelText('Bolum sec');
    expect(select).toHaveAttribute('aria-label', 'Bolum sec');
  });

  it('content area is within a <main> element', () => {
    renderDocsPage();
    const main = screen.getByRole('main');
    expect(main).toBeInTheDocument();
  });

  it('nav element is present for top navigation bar', () => {
    renderDocsPage();
    const navElements = screen.getAllByRole('navigation');
    expect(navElements.length).toBeGreaterThanOrEqual(1);
  });

  it('heading hierarchy starts with h2 in section content', () => {
    renderDocsPage();
    const h2 = screen.getByText('Welcome');
    expect(h2.tagName).toBe('H2');
  });
});
