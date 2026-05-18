import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Lightweight i18n stub. Returns the key for unknown ids so older tests
// keep matching "{key.path}"; substitutes {n}/{total} for the PR-C
// counter so the rendered label is readable in DOM queries.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      if (key === 'chat.criticFindings.selectedCount') return '{n}/{total} öneri seçildi';
      if (key === 'chat.criticFindings.applySelected') return 'Seçilenleri uygula';
      if (key === 'chat.criticFindings.applying') return 'Uygulanıyor...';
      if (key === 'chat.criticFindings.checkbox.aria')
        return 'Bu öneriyi uygulanacak listeye ekle';
      if (key === 'chat.criticFindings.feedbackHeader')
        return 'Aşağıdaki Critic önerileri uygulansın:';
      if (key === 'chat.criticFindings.applyError') return 'Düzeltme gönderilemedi.';
      return key;
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { ExplanationPanel } from '../ExplanationPanel';
import type {
  PipelineExplanation,
  AgentReasoning,
  ReasoningFinding,
} from '../../../types/pipeline';

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

// ─────────────────────────────────────────────────────────
// PR-C — Critic suggestion checkbox + "Seçilenleri uygula"
// ─────────────────────────────────────────────────────────

const mkFinding = (over: Partial<ReasoningFinding> = {}): ReasoningFinding => ({
  severity: 'major',
  category: 'completeness',
  description: 'desc',
  suggestion: 'do x',
  ...over,
});

const mkCriticStage = (findings: ReasoningFinding[]): AgentReasoning => ({
  agentName: 'critic',
  timestamp: new Date('2026-05-08T10:00:00Z').toISOString(),
  decision: 'Code review tamamlandı',
  reasoning: [],
  assumptions: [],
  confidence: { score: 60, factors: [] },
  findings,
});

describe('ExplanationPanel — PR-C suggestion selection', () => {
  it('renders a checkbox for every finding that has a non-empty suggestion', () => {
    const findings = [
      mkFinding({ category: 'completeness', description: 'A', suggestion: 'fix A' }),
      mkFinding({ category: 'security', description: 'B', suggestion: 'fix B' }),
      mkFinding({ category: 'completeness', description: 'C', suggestion: 'fix C' }),
    ];
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={vi.fn()}
      />
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(screen.getByText('0/3 öneri seçildi')).toBeInTheDocument();
    expect(screen.getByTestId('critic-findings-apply-button')).toBeDisabled();
  });

  it('does not render a checkbox for findings that have no suggestion', () => {
    const findings = [
      mkFinding({ description: 'A', suggestion: 'fix A' }),
      mkFinding({ description: 'B', suggestion: '' }),
    ];
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={vi.fn()}
      />
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('0/1 öneri seçildi')).toBeInTheDocument();
  });

  it('updates the selected counter as the user toggles checkboxes', () => {
    const findings = [
      mkFinding({ description: 'A', suggestion: 'fix A' }),
      mkFinding({ description: 'B', suggestion: 'fix B' }),
      mkFinding({ description: 'C', suggestion: 'fix C' }),
    ];
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={vi.fn()}
      />
    );
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    expect(screen.getByText('1/3 öneri seçildi')).toBeInTheDocument();
    fireEvent.click(boxes[2]);
    expect(screen.getByText('2/3 öneri seçildi')).toBeInTheDocument();
    fireEvent.click(boxes[0]);
    expect(screen.getByText('1/3 öneri seçildi')).toBeInTheDocument();
  });

  it('apply button calls iterateWithFeedback with a numbered, header-prefixed prompt', async () => {
    const findings = [
      mkFinding({ category: 'completeness', description: 'A', suggestion: 'fix A' }),
      mkFinding({ category: 'security', description: 'B', suggestion: 'fix B' }),
    ];
    const iterate = vi.fn().mockResolvedValue(undefined);
    const onIterationStarted = vi.fn();
    render(
      <ExplanationPanel
        pipelineId="p-42"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
        onIterationStarted={onIterationStarted}
      />
    );
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

    await waitFor(() => expect(iterate).toHaveBeenCalledTimes(1));
    const [pipelineId, feedback] = iterate.mock.calls[0];
    expect(pipelineId).toBe('p-42');
    expect(feedback).toContain('Aşağıdaki Critic önerileri uygulansın:');
    expect(feedback).toMatch(/1\.\s.+/);
    expect(feedback).toMatch(/2\.\s.+/);
    // Both selected suggestions should appear regardless of grouping order.
    expect(feedback).toContain('fix A');
    expect(feedback).toContain('fix B');

    await waitFor(() => expect(onIterationStarted).toHaveBeenCalled());
    // Selection should reset after a successful apply.
    expect(screen.getByText('0/2 öneri seçildi')).toBeInTheDocument();
  });

  it('apply button stays disabled when nothing is selected', () => {
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={vi.fn()}
      />
    );
    expect(screen.getByTestId('critic-findings-apply-button')).toBeDisabled();
  });

  it('hides the apply bar when no finding has a non-empty suggestion', () => {
    const findings = [mkFinding({ description: 'A', suggestion: '' })];
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={vi.fn()}
      />
    );
    expect(screen.queryByTestId('critic-findings-apply-bar')).toBeNull();
    expect(screen.queryByTestId('critic-findings-apply-button')).toBeNull();
  });

  it('surfaces an inline error if iterateWithFeedback rejects', async () => {
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    const iterate = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'));
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));
    expect(await screen.findByTestId('critic-findings-apply-error')).toHaveTextContent(
      '429 Too Many Requests'
    );
    // Selection survives a failed apply so the user can retry.
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
