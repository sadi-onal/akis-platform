import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub useI18n so assertions can match raw i18n keys directly. Mirrors the
// pattern used by ConfidenceBadge / ExplanationPanel tests.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { AcCoverageChecklist } from '../AcCoverageChecklist';
import type { AcCoverageReport } from '../../../types/pipeline';

function makeReport(items: AcCoverageReport['items']): AcCoverageReport {
  return {
    totalAcs: items.length,
    staticCoveredCount: items.filter((i) => i.staticCovered).length,
    dynamicCoveredCount: items.filter((i) => i.dynamicCovered).length,
    items,
  };
}

describe('AcCoverageChecklist', () => {
  it('renders empty-state when totalAcs === 0', () => {
    render(<AcCoverageChecklist report={makeReport([])} />);
    expect(screen.getByTestId('ac-coverage-empty')).toBeInTheDocument();
  });

  it('renders static-only summary when no Trace data', () => {
    const report = makeReport([
      {
        acId: 'ac-1',
        acDescription: 'QR butonu PNG indirir',
        staticCovered: true,
        dynamicCovered: false,
        coveringFiles: ['src/QR.tsx'],
        coveringTests: [],
      },
      {
        acId: 'ac-2',
        acDescription: 'Kullanıcı geçmişi görür',
        staticCovered: false,
        dynamicCovered: false,
        coveringFiles: [],
        coveringTests: [],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    // i18n mock returns the raw key (no `{n}/{total}` interpolation), so
    // assert the static summary key is present and the dynamic key is not.
    const summary = screen.getByTestId('ac-coverage-summary');
    expect(summary.textContent).toContain('pipeline.acCoverage.summaryStatic');
    expect(summary.textContent).not.toContain('pipeline.acCoverage.summaryDynamic');
    // No dynamic badge anywhere
    expect(screen.queryByTestId('ac-coverage-dynamic-badge-ac-1')).not.toBeInTheDocument();
  });

  it('renders the dynamic summary key when Trace covered at least one AC', () => {
    const report = makeReport([
      {
        acId: 'ac-1',
        acDescription: 'a',
        staticCovered: true,
        dynamicCovered: true,
        coveringFiles: ['src/a.ts'],
        coveringTests: ['tests/a.spec.ts'],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    const summary = screen.getByTestId('ac-coverage-summary');
    expect(summary.textContent).toContain('pipeline.acCoverage.summaryStatic');
    expect(summary.textContent).toContain('pipeline.acCoverage.summaryDynamic');
  });

  it('renders the dynamic badge for AC where Trace ran', () => {
    const report = makeReport([
      {
        acId: 'ac-1',
        acDescription: 'QR PNG indirir',
        staticCovered: true,
        dynamicCovered: true,
        coveringFiles: ['src/QR.tsx'],
        coveringTests: ['tests/qr.spec.ts'],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    expect(screen.getByTestId('ac-coverage-dynamic-badge-ac-1')).toBeInTheDocument();
  });

  it('marks uncovered rows with notCovered status', () => {
    const report = makeReport([
      {
        acId: 'ac-3',
        acDescription: 'Sosyal medya paylaşımı',
        staticCovered: false,
        dynamicCovered: false,
        coveringFiles: [],
        coveringTests: [],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    const row = screen.getByTestId('ac-coverage-item-ac-3');
    expect(row).toHaveAttribute('data-covered', 'false');
    expect(row.textContent).toContain('pipeline.acCoverage.notCovered');
  });

  it('renders the covering-files row for covered AC when showDetails (default)', () => {
    const report = makeReport([
      {
        acId: 'ac-1',
        acDescription: 'QR PNG',
        staticCovered: true,
        dynamicCovered: false,
        coveringFiles: ['src/QR.tsx', 'src/utils/png.ts'],
        coveringTests: [],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    const row = screen.getByTestId('ac-coverage-item-ac-1');
    // i18n mock returns the raw key. The replacement of `{files}` is done
    // by the component on the value returned from `t()` — since `t()`
    // returns the key itself in tests, the key string is what we get.
    // Assert the coveringFiles key is rendered (proof the conditional ran).
    expect(row.textContent).toContain('pipeline.acCoverage.coveringFiles');
  });

  it('hides the list when the user clicks the toggle', () => {
    const report = makeReport([
      {
        acId: 'ac-1',
        acDescription: 'QR PNG',
        staticCovered: true,
        dynamicCovered: false,
        coveringFiles: [],
        coveringTests: [],
      },
    ]);
    render(<AcCoverageChecklist report={report} />);
    // The list starts expanded
    expect(screen.getByTestId('ac-coverage-items')).toBeInTheDocument();
    // Click the toggle (button text uses i18n keys; find by role)
    const toggle = screen.getByRole('button', { expanded: true });
    fireEvent.click(toggle);
    expect(screen.queryByTestId('ac-coverage-items')).not.toBeInTheDocument();
  });
});
