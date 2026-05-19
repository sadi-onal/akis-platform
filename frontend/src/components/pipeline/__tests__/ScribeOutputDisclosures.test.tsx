/**
 * ScribeOutputDisclosures (PR-V6) — edge-case sweep, 2026-05-19.
 *
 * The component is consumed by PlanCard and ExplanationPanel, both of
 * which have happy-path tests. This file pins down the boundary
 * behaviour the consumer tests don't cover:
 *   - which sections render with partial spec data
 *   - userStory shape variants (persona vs as, action vs iWant, …)
 *   - empty arrays + nullish flips
 *   - AC fallback rendering when optional fields are absent
 *
 * Pure presentational component — no i18n, no async — so tests are
 * fast and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ScribeOutputDisclosures } from '../ScribeOutputDisclosures';
import type { StructuredSpec } from '../../../types/workflow';

const fullSpec: StructuredSpec = {
  problemStatement: 'Kullanıcılar X yapamıyor.',
  userStories: [{ persona: 'Bakkal', action: 'kayıt ol', benefit: 'satmak' }],
  acceptanceCriteria: [{ id: 'AC-1', given: 'A', when: 'B', then: 'C' }],
  outOfScope: ['multi-currency'],
};

describe('ScribeOutputDisclosures — render gating', () => {
  it('returns null when neither spec nor assumptions carry content', () => {
    const { container } = render(<ScribeOutputDisclosures />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when spec is provided but all sections are empty', () => {
    const { container } = render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
        assumptions={[]}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when spec is null and assumptions is null', () => {
    const { container } = render(<ScribeOutputDisclosures spec={null} assumptions={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders ONLY the assumptions disclosure when spec is absent but assumptions are present', () => {
    render(<ScribeOutputDisclosures assumptions={['Tek ülke']} />);
    expect(screen.getByTestId('scribe-assumptions-disclosure')).toBeInTheDocument();
    expect(screen.queryByTestId('scribe-acceptance-criteria-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-problem-statement-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-user-stories-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-out-of-scope-disclosure')).toBeNull();
  });

  it('renders ONLY the AC disclosure when other sections are empty/missing', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [{ given: 'A', when: 'B', then: 'C' }],
          outOfScope: [],
        }}
      />
    );
    expect(screen.getByTestId('scribe-acceptance-criteria-disclosure')).toBeInTheDocument();
    expect(screen.queryByTestId('scribe-problem-statement-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-user-stories-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-out-of-scope-disclosure')).toBeNull();
    expect(screen.queryByTestId('scribe-assumptions-disclosure')).toBeNull();
  });

  it('passes through className on the wrapper div', () => {
    const { container } = render(
      <ScribeOutputDisclosures spec={fullSpec} className="custom-class" />
    );
    const wrapper = container.querySelector('[data-testid="scribe-output-disclosures"]');
    expect(wrapper).toHaveClass('custom-class');
  });
});

describe('ScribeOutputDisclosures — AC rendering edge cases', () => {
  it('renders an AC whose id and summary are missing — fallback to given/when/then', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [
            { given: 'verilen-text', when: 'olduğunda-text', then: 'sonuç-text' },
          ],
          outOfScope: [],
        }}
      />
    );
    expect(screen.getByText('verilen-text')).toBeInTheDocument();
    expect(screen.getByText('olduğunda-text')).toBeInTheDocument();
    expect(screen.getByText('sonuç-text')).toBeInTheDocument();
  });

  it('renders the AC id in monospace label format when present', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [{ id: 'AC-42', given: 'x', when: 'y', then: 'z' }],
          outOfScope: [],
        }}
      />
    );
    expect(screen.getByText('AC-42')).toBeInTheDocument();
  });

  it('exposes the exact AC count in the summary label', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [
            { given: 'a', when: 'b', then: 'c' },
            { given: 'd', when: 'e', then: 'f' },
            { given: 'g', when: 'h', then: 'i' },
          ],
          outOfScope: [],
        }}
      />
    );
    const disclosure = screen.getByTestId('scribe-acceptance-criteria-disclosure');
    expect(disclosure.textContent).toMatch(/Kabul Kriterleri \(3\)/);
  });
});

describe('ScribeOutputDisclosures — user story shape variants', () => {
  it('renders a story that uses the `as` / `iWant` / `soThat` aliases', () => {
    // Backend has historically emitted both shapes — the component must
    // accept either without showing "undefined".
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [{ as: 'Esnaf', iWant: 'fatura kesmek', soThat: 'gelir kayıtlı kalsın' }],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
      />
    );
    const disclosure = screen.getByTestId('scribe-user-stories-disclosure');
    expect(disclosure).toBeInTheDocument();
    expect(disclosure.textContent).toContain('Esnaf');
    expect(disclosure.textContent).toContain('fatura kesmek');
    expect(disclosure.textContent).toContain('gelir kayıtlı kalsın');
    expect(disclosure.textContent).not.toContain('undefined');
  });

  it('falls back to "Kullanıcı" when neither persona nor as is provided', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [{ action: 'X yap', benefit: 'Y olsun' }],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
      />
    );
    // The story list-item renders the persona inside a <span>. The summary
    // label "Kullanıcı Hikayeleri" is a different element, so scope the
    // query to the disclosure body content (excluding the summary).
    const disclosure = screen.getByTestId('scribe-user-stories-disclosure');
    const ul = disclosure.querySelector('ul');
    expect(ul?.textContent).toContain('Kullanıcı');
    expect(ul?.textContent).toContain('X yap');
  });

  it('skips the action+benefit suffixes gracefully when both are missing', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [{ persona: 'Yalnız Kişi' }],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
      />
    );
    const li = screen.getByText('Yalnız Kişi');
    // No "şunu yapmak istiyor" suffix when action is missing.
    expect(li.parentElement?.textContent).not.toMatch(/şunu yapmak istiyor/);
    expect(li.parentElement?.textContent).not.toMatch(/böylece/);
  });
});

describe('ScribeOutputDisclosures — counts in summary labels', () => {
  it('shows the exact user story count', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [
            { persona: 'A' },
            { persona: 'B' },
            { persona: 'C' },
            { persona: 'D' },
            { persona: 'E' },
          ],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
      />
    );
    expect(screen.getByTestId('scribe-user-stories-disclosure').textContent).toMatch(
      /Kullanıcı Hikayeleri \(5\)/
    );
  });

  it('shows the exact out-of-scope count', () => {
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: '',
          userStories: [],
          acceptanceCriteria: [],
          outOfScope: ['offline', 'multi-currency', 'admin role'],
        }}
      />
    );
    expect(screen.getByTestId('scribe-out-of-scope-disclosure').textContent).toMatch(
      /Kapsam Dışı \(3\)/
    );
  });

  it('shows the exact assumptions count', () => {
    render(<ScribeOutputDisclosures assumptions={['A', 'B']} />);
    expect(screen.getByTestId('scribe-assumptions-disclosure').textContent).toMatch(
      /Varsayımlar \(2\)/
    );
  });
});

describe('ScribeOutputDisclosures — content escaping (no raw HTML injection)', () => {
  it('renders user-provided HTML-looking text as plain text, not as DOM', () => {
    // React text rendering already escapes; this test just pins that
    // contract — a future "render as markdown" refactor would silently
    // break it unless a guard explicit-sanitizes.
    const dangerousPS = '<script>alert(1)</script>';
    render(
      <ScribeOutputDisclosures
        spec={{
          problemStatement: dangerousPS,
          userStories: [],
          acceptanceCriteria: [],
          outOfScope: [],
        }}
      />
    );
    // The literal angle-bracketed text is in the DOM as text.
    expect(screen.getByText(dangerousPS)).toBeInTheDocument();
    // And there's no real <script> tag in the rendered tree.
    expect(document.querySelector('script')).toBeNull();
  });
});
