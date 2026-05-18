import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ConfidenceBadge (transitively rendered) requires I18nProvider; stub here.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { ExplanationPanel } from '../ExplanationPanel';
import type { PipelineExplanation, AgentReasoning } from '../../../types/pipeline';

const mkStage = (overrides: Partial<AgentReasoning> = {}): AgentReasoning => ({
  agentName: 'scribe',
  timestamp: new Date('2026-05-07T10:00:00Z').toISOString(),
  decision: 'Spec uretildi',
  reasoning: ['1 soru soruldu', '3 AC yazildi'],
  assumptions: ['React kullanilacak'],
  confidence: { score: 90, factors: ['AC sayisi: 3'] },
  ...overrides,
});

const mkExplanation = (overrides: Partial<PipelineExplanation> = {}): PipelineExplanation => ({
  pipelineId: 'p-1',
  stages: [mkStage()],
  overallNarrative: 'Pipeline başarıyla tamamlandı.',
  attentionPoints: [],
  ...overrides,
});

describe('ExplanationPanel', () => {
  it('renders priming explanation without fetching', () => {
    const fetcher = vi.fn();
    render(<ExplanationPanel pipelineId="p-1" explanation={mkExplanation()} fetcher={fetcher} />);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText(/Spec uretildi/)).toBeInTheDocument();
  });

  it('fetches explanation when not primed', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExplanation());
    render(<ExplanationPanel pipelineId="p-1" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
    expect(await screen.findByText(/Spec uretildi/)).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<ExplanationPanel pipelineId="p-1" fetcher={fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });

  it('renders empty-state when no stages', () => {
    render(<ExplanationPanel pipelineId="p-1" explanation={mkExplanation({ stages: [] })} />);
    expect(screen.getByText(/Henüz açıklama yok/)).toBeInTheDocument();
    expect(screen.getByText(/Pipeline ilerledikçe/)).toBeInTheDocument();
  });

  it('renders persistencePreEpoch banner for legacy completed pipelines (F-11)', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [], meta: { persistencePreEpoch: true } })}
      />
    );
    expect(
      screen.getByText(/Bu pipeline eski sürümde tamamlandı, açıklama kaydı yok/)
    ).toBeInTheDocument();
    expect(screen.getByText(/İsterseniz yeniden çalıştırabilirsiniz/)).toBeInTheDocument();
    // The generic empty state should NOT appear when the legacy banner does.
    expect(screen.queryByText(/Henüz açıklama yok/)).toBeNull();
  });

  // PR-B (2026-05-18): the panel no longer renders an inline
  // AttentionBanner. Attention points live on the Akış tab of
  // PipelineDetailRail; surfacing them here too duplicated the banner and
  // pushed the per-stage reasoning cards below the fold. The Açıklama tab
  // is now reserved for stage-level "neden böyle karar verdi" content.
  it('does not render an attention banner even when points exist', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({
          attentionPoints: [{ severity: 'high', stage: 'critic', issue: 'XSS açığı' }],
        })}
      />
    );
    expect(screen.queryByText('XSS açığı')).toBeNull();
    expect(screen.queryByText('Önemli')).toBeNull();
  });

  it('toggles details section per stage', () => {
    render(<ExplanationPanel pipelineId="p-1" explanation={mkExplanation()} />);
    expect(screen.queryByText('React kullanilacak')).toBeNull();
    fireEvent.click(screen.getByText('▸ Detayları göster'));
    expect(screen.getByText('React kullanilacak')).toBeInTheDocument();
    fireEvent.click(screen.getByText('▾ Detayları gizle'));
    expect(screen.queryByText('React kullanilacak')).toBeNull();
  });

  it('renders multiple stages in order with formatted agent names', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({
          stages: [
            mkStage({ agentName: 'scribe', decision: 'A' }),
            mkStage({ agentName: 'critic', decision: 'B' }),
            mkStage({ agentName: 'proto', decision: 'C' }),
            mkStage({ agentName: 'trace', decision: 'D' }),
          ],
        })}
      />
    );
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Scribe', 'Critic', 'Proto', 'Trace']);
  });

  it('shows risks in red when present and detail expanded', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({
          stages: [mkStage({ risks: ['Auth bypass riski'] })],
        })}
        defaultExpanded
      />
    );
    expect(screen.getByText('Auth bypass riski')).toBeInTheDocument();
    expect(screen.getByText('Riskler')).toBeInTheDocument();
  });

  it('renders overall narrative footer', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ overallNarrative: 'Özetlenmiş hikaye' })}
      />
    );
    expect(screen.getByText('Özetlenmiş hikaye')).toBeInTheDocument();
  });
});
