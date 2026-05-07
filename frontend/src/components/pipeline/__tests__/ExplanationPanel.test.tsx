import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

  it('renders attention banner when points exist', () => {
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({
          attentionPoints: [{ severity: 'high', stage: 'critic', issue: 'XSS açığı' }],
        })}
      />
    );
    expect(screen.getByText('XSS açığı')).toBeInTheDocument();
    expect(screen.getByText('Önemli')).toBeInTheDocument();
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
