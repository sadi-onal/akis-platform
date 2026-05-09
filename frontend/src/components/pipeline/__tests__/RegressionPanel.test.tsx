import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { RegressionPanel } from '../RegressionPanel';
import type { RegressionReport } from '../../../types/pipeline';

function makeReport(overrides: Partial<RegressionReport> = {}): RegressionReport {
  return {
    pipelineId: 'p-1',
    baseline: {
      totalTests: 6,
      coveragePercentage: 100,
      coveredCriteria: ['ac-1', 'ac-2'],
      uncoveredCriteria: [],
    },
    fixLoop: { runs: 0, succeeded: false, triggered: false },
    status: 'verified_baseline',
    headline: 'Doğrulanmış baseline: 6 test, %100 kapsam',
    bakkalSummary: 'Projenin baseline güveni: 6 testle %100 kapsam.',
    ...overrides,
  };
}

describe('RegressionPanel — fetch + render', () => {
  it('renders the fetched report through the DI fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeReport());
    render(<RegressionPanel pipelineId="p-1" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
    expect(
      await screen.findByText(/Doğrulanmış baseline: 6 test, %100 kapsam/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Projenin baseline güveni: 6 testle %100 kapsam/)).toBeInTheDocument();
  });

  it('renders an alert when the fetcher rejects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<RegressionPanel pipelineId="p-1" fetcher={fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});

describe('RegressionPanel — status pill', () => {
  it('applies the verified_baseline pill class for a passing baseline', () => {
    render(
      <RegressionPanel pipelineId="p-1" report={makeReport({ status: 'verified_baseline' })} />
    );
    const pill = screen.getByTestId('regression-status-pill');
    expect(pill.className).toMatch(/emerald/);
    expect(pill).toHaveTextContent('Doğrulanmış');
  });

  it('applies the self_healed pill class when FixLoop succeeded', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          status: 'self_healed',
          fixLoop: { runs: 2, succeeded: true, triggered: true },
          headline: 'Kendini düzeltti: FixLoop 2 kez çalıştı',
        })}
      />
    );
    const pill = screen.getByTestId('regression-status-pill');
    expect(pill.className).toMatch(/sky/);
    expect(pill).toHaveTextContent('Kendini düzeltti');
  });

  it('applies the degraded pill class when AC are uncovered', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          status: 'degraded',
          baseline: {
            totalTests: 4,
            coveragePercentage: 50,
            coveredCriteria: ['ac-1'],
            uncoveredCriteria: ['ac-2'],
          },
          headline: 'Eksik kapsam: 1 kriter dışarıda',
        })}
      />
    );
    const pill = screen.getByTestId('regression-status-pill');
    expect(pill.className).toMatch(/amber/);
  });

  it('applies the no_baseline pill class when Trace never ran', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          status: 'no_baseline',
          baseline: null,
          headline: 'Test taban çizgisi yok',
        })}
      />
    );
    const pill = screen.getByTestId('regression-status-pill');
    expect(pill.className).toMatch(/slate/);
    expect(pill).toHaveTextContent('Test taban çizgisi yok');
  });
});

describe('RegressionPanel — tiles', () => {
  it('renders three tiles always', () => {
    render(<RegressionPanel pipelineId="p-1" report={makeReport()} />);
    const tiles = screen.getAllByTestId('regression-tile');
    expect(tiles).toHaveLength(3);
  });

  it('shows "—" for the Baseline tile when there is no baseline', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({ baseline: null, status: 'no_baseline' })}
      />
    );
    const tiles = screen.getAllByTestId('regression-tile');
    const baselineTile = tiles[1]!; // 0=files 1=baseline 2=fixloop
    expect(within(baselineTile).getByText('—')).toBeInTheDocument();
    expect(within(baselineTile).getByText('baseline yok')).toBeInTheDocument();
  });

  it('shows the iterationRequest chip truncated when long', () => {
    const longRequest = 'a'.repeat(120);
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          iterationRequest: longRequest,
          iterationFilesChanged: 2,
          parentPipelineId: 'p-root',
        })}
      />
    );
    // Chip text should be truncated below the full length.
    const chipText = screen.getByText(/^a+…$/);
    expect(chipText.textContent!.length).toBeLessThan(longRequest.length);
    // Full text exposed via title attribute.
    expect(chipText.parentElement).toHaveAttribute('title', longRequest);
  });
});

describe('RegressionPanel — FixLoop suffix', () => {
  it('says "düzeldi" when the FixLoop succeeded', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          status: 'self_healed',
          fixLoop: { runs: 1, succeeded: true, triggered: true },
        })}
      />
    );
    const tiles = screen.getAllByTestId('regression-tile');
    expect(within(tiles[2]!).getByText('düzeldi')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('1 kez')).toBeInTheDocument();
  });

  it('says "başarısız" when the FixLoop ran but failed', () => {
    render(
      <RegressionPanel
        pipelineId="p-1"
        report={makeReport({
          status: 'degraded',
          fixLoop: { runs: 3, succeeded: false, triggered: true },
        })}
      />
    );
    const tiles = screen.getAllByTestId('regression-tile');
    expect(within(tiles[2]!).getByText('başarısız')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('3 kez')).toBeInTheDocument();
  });

  it('says "tetiklenmedi" when no FixLoop ran', () => {
    render(<RegressionPanel pipelineId="p-1" report={makeReport()} />);
    const tiles = screen.getAllByTestId('regression-tile');
    expect(within(tiles[2]!).getByText('tetiklenmedi')).toBeInTheDocument();
  });
});

describe('RegressionPanel — Turkish labels', () => {
  it('uses Turkish copy for tile labels', () => {
    render(<RegressionPanel pipelineId="p-1" report={makeReport()} />);
    expect(screen.getByText('Değişen dosya')).toBeInTheDocument();
    expect(screen.getByText('Baseline test')).toBeInTheDocument();
    expect(screen.getByText('FixLoop')).toBeInTheDocument();
  });
});
