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
      if (key === 'chat.criticFindings.checkbox.aria') return 'Bu öneriyi uygulanacak listeye ekle';
      if (key === 'chat.criticFindings.feedbackHeader')
        return 'Aşağıdaki Critic önerileri uygulansın:';
      if (key === 'chat.criticFindings.applyError') return 'Düzeltme gönderilemedi.';
      if (key === 'chat.criticFindings.applySuccess') return 'Yeni Proto iterasyonu başladı.';
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
import type { StructuredSpec } from '../../../types/workflow';

const mkSpec = (overrides: Partial<StructuredSpec> = {}): StructuredSpec => ({
  title: 'Görev Yönetim Uygulaması',
  problemStatement: 'Kullanıcı görevlerini takip etmek istiyor.',
  userStories: [
    {
      persona: 'Yönetici',
      as: 'Yönetici',
      action: 'görev oluştur',
      iWant: 'görev oluştur',
      benefit: 'ekip ilerlesin',
      soThat: 'ekip ilerlesin',
    },
  ],
  acceptanceCriteria: [
    { id: 'AC-1', given: 'liste boş', when: 'görev eklerim', then: 'listede görünür' },
    { id: 'AC-2', given: 'görev var', when: 'tamamlandı işaretlerim', then: 'arşivlenir' },
  ],
  outOfScope: ['Mobil uygulama'],
  ...overrides,
});

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

  // PR-V6-fix (2026-05-20): when reasoning persistence has no rows yet
  // (pipeline_reasonings empty) the panel used to early-return a placeholder
  // and the Scribe spec disclosures threaded via `scribeSpec` silently
  // disappeared — even when `workflow.stages.scribe.spec` was fully
  // populated. Smoke verification on 2026-05-19 found DOM had 0
  // `<details>` elements in that scenario. The fix renders a fallback
  // Scribe card with the spec disclosures whenever `scribeSpec` carries
  // content, regardless of `explanation.stages.length`.
  describe('PR-V6-fix — Scribe disclosures fallback when no reasoning rows', () => {
    it('renders spec disclosures when stages is empty but scribeSpec is provided', () => {
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({ stages: [] })}
          scribeSpec={mkSpec()}
        />
      );
      expect(screen.getByTestId('scribe-spec-fallback-card')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-output-disclosures')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-acceptance-criteria-disclosure')).toBeInTheDocument();
      expect(screen.getByText(/Kabul Kriterleri \(2\)/)).toBeInTheDocument();
      // Placeholder still appears below so the "no reasoning rows" signal is not lost
      expect(screen.getByText(/Henüz açıklama yok/)).toBeInTheDocument();
    });

    it('renders spec disclosures when stages is empty + persistencePreEpoch flag is set', () => {
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({ stages: [], meta: { persistencePreEpoch: true } })}
          scribeSpec={mkSpec()}
        />
      );
      expect(screen.getByTestId('scribe-spec-fallback-card')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-acceptance-criteria-disclosure')).toBeInTheDocument();
      expect(
        screen.getByText(/Bu pipeline eski sürümde tamamlandı, açıklama kaydı yok/)
      ).toBeInTheDocument();
    });

    it('renders assumption disclosure when only scribeAssumptions are provided (empty stages)', () => {
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({ stages: [] })}
          scribeAssumptions={['Modal kullanılacak', 'PostgreSQL veritabanı']}
        />
      );
      expect(screen.getByTestId('scribe-spec-fallback-card')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-assumptions-disclosure')).toBeInTheDocument();
      expect(screen.getByText(/Varsayımlar \(2\)/)).toBeInTheDocument();
    });

    it('falls through to the placeholder when stages empty AND no spec/assumptions', () => {
      render(<ExplanationPanel pipelineId="p-1" explanation={mkExplanation({ stages: [] })} />);
      expect(screen.queryByTestId('scribe-spec-fallback-card')).toBeNull();
      expect(screen.queryByTestId('scribe-output-disclosures')).toBeNull();
      expect(screen.getByText(/Henüz açıklama yok/)).toBeInTheDocument();
    });

    it('renders fallback card when stages have rows but no Scribe stage row', () => {
      // Partial persistence: Proto reasoning persisted but the Scribe row was
      // dropped. ReasoningCard's `agentName === 'scribe'` gate would never
      // fire so the disclosures stayed hidden. The fallback card surfaces
      // them at the top of the panel.
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({
            stages: [mkStage({ agentName: 'proto', decision: 'Proto karar' })],
          })}
          scribeSpec={mkSpec()}
        />
      );
      expect(screen.getByTestId('scribe-spec-fallback-card')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-acceptance-criteria-disclosure')).toBeInTheDocument();
      // Proto stage card is still rendered below
      expect(screen.getByText('Proto karar')).toBeInTheDocument();
    });

    it('does NOT render fallback card when stages already contain a Scribe stage', () => {
      // Happy path — ReasoningCard's existing `showScribeOutputs` gate handles
      // the disclosure rendering. Adding a second fallback card would create
      // a duplicate UI.
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({
            stages: [mkStage({ agentName: 'scribe', decision: 'Scribe karar' })],
          })}
          scribeSpec={mkSpec()}
        />
      );
      expect(screen.queryByTestId('scribe-spec-fallback-card')).toBeNull();
      // The disclosures still render — via the Scribe ReasoningCard
      expect(screen.getByTestId('scribe-output-disclosures')).toBeInTheDocument();
      expect(screen.getByTestId('scribe-acceptance-criteria-disclosure')).toBeInTheDocument();
    });
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

// ─────────────────────────────────────────────────────────
// PR-V4 — Apply toast (success + error + auto-dismiss)
// ─────────────────────────────────────────────────────────

describe('ExplanationPanel — PR-V4 apply toast', () => {
  it('shows a visible success toast after a successful apply', async () => {
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    const iterate = vi.fn().mockResolvedValue(undefined);
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

    const toast = await screen.findByTestId('critic-apply-toast');
    expect(toast).toHaveAttribute('data-toast-kind', 'success');
    expect(toast).toHaveTextContent(/başladı/i);
  });

  it('shows an error-styled toast when the apply fails', async () => {
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    const iterate = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

    const toast = await screen.findByTestId('critic-apply-toast');
    expect(toast).toHaveAttribute('data-toast-kind', 'error');
    expect(toast).toHaveTextContent(/Düzeltme gönderilemedi/);
  });

  it('auto-dismisses the toast after 4 seconds', async () => {
    vi.useFakeTimers();
    try {
      const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
      const iterate = vi.fn().mockResolvedValue(undefined);
      render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
          iterateWithFeedback={iterate}
        />
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

      // Flush the pending promise so the success branch runs and sets the
      // toast state. waitFor itself drives fake timers forward via act().
      await vi.waitFor(() => {
        expect(screen.getByTestId('critic-apply-toast')).toBeInTheDocument();
      });

      vi.advanceTimersByTime(4000);

      await vi.waitFor(() => {
        expect(screen.queryByTestId('critic-apply-toast')).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── PR-V4 edge-case regression tests (test sweep, 2026-05-19) ────────

  it('rapid double-click on apply only triggers a single iterateWithFeedback call (busy guard)', async () => {
    // The button uses `disabled={selected.size === 0 || busy}` so the second
    // click should be a no-op while the first promise is still pending.
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    let resolveIter: (v: unknown) => void = () => undefined;
    const iterate = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveIter = r;
        })
    );
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    const btn = screen.getByTestId('critic-findings-apply-button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(iterate).toHaveBeenCalledTimes(1);
    resolveIter(undefined);
  });

  it('error path renders the toast when iterateWithFeedback rejects with a non-Error value', async () => {
    // The handler computes `e instanceof Error ? e.message : t('applyError')`.
    // Throwing a plain string (some HTTP wrappers do this) must still fall
    // through to the toast — the catch branch sets the same applyError
    // message in both inline banner + toast.
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    const iterate = vi.fn().mockRejectedValue('plain-string-rejection');
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

    const toast = await screen.findByTestId('critic-apply-toast');
    expect(toast).toHaveAttribute('data-toast-kind', 'error');
    expect(toast).toHaveTextContent(/Düzeltme gönderilemedi/);
  });

  it('toast has role=status + aria-live=polite (screen-reader announcement)', async () => {
    const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
    const iterate = vi.fn().mockResolvedValue(undefined);
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
        iterateWithFeedback={iterate}
      />
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('critic-findings-apply-button'));

    const toast = await screen.findByTestId('critic-apply-toast');
    // PR-V4 spec: a11y attributes for screen-reader users.
    expect(toast).toHaveAttribute('role', 'status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
  });

  it('toast timer is cleared on unmount (no leaked setTimeout after success)', async () => {
    // Guard: the useEffect cleanup must call clearTimeout so unmounting
    // immediately after a successful apply doesn't fire a setState on an
    // unmounted component (React 18 logs a warning if it happens).
    vi.useFakeTimers();
    try {
      const findings = [mkFinding({ description: 'A', suggestion: 'fix A' })];
      const iterate = vi.fn().mockResolvedValue(undefined);
      const { unmount } = render(
        <ExplanationPanel
          pipelineId="p-1"
          explanation={mkExplanation({ stages: [mkCriticStage(findings)] })}
          iterateWithFeedback={iterate}
        />
      );
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('critic-findings-apply-button'));
      await vi.waitFor(() => expect(screen.getByTestId('critic-apply-toast')).toBeInTheDocument());

      // Unmount before the 4s window elapses; spy on console.error so a
      // React "setState on unmounted component" warning surfaces as a fail.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      unmount();
      vi.advanceTimersByTime(5000);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringMatching(/unmounted|memory leak/i));
      errSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── PR-D: AC coverage integration ───────────────────────────

describe('ExplanationPanel — AC coverage (PR-D)', () => {
  it('renders the AC checklist inside the Proto card when acCoverage is provided', () => {
    const protoStage = mkStage({
      agentName: 'proto',
      decision: 'İskelet üretildi: 5 dosya',
      reasoning: ['eski bullet listesi'],
    });
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [protoStage] })}
        acCoverage={{
          totalAcs: 2,
          staticCoveredCount: 1,
          dynamicCoveredCount: 0,
          items: [
            {
              acId: 'ac-1',
              acDescription: 'QR PNG indir',
              staticCovered: true,
              dynamicCovered: false,
              coveringFiles: ['src/QR.tsx'],
              coveringTests: [],
            },
            {
              acId: 'ac-2',
              acDescription: 'Geçmiş listesi',
              staticCovered: false,
              dynamicCovered: false,
              coveringFiles: [],
              coveringTests: [],
            },
          ],
        }}
      />
    );
    expect(screen.getByTestId('ac-coverage')).toBeInTheDocument();
    expect(screen.getByTestId('ac-coverage-item-ac-1')).toHaveAttribute('data-covered', 'true');
    expect(screen.getByTestId('ac-coverage-item-ac-2')).toHaveAttribute('data-covered', 'false');
    // Legacy bullet list should NOT render alongside — the AC checklist
    // replaces it for Proto when AC are available.
    expect(screen.queryByText('eski bullet listesi')).toBeNull();
  });

  it('falls back to bullet list when no acCoverage is provided', () => {
    const protoStage = mkStage({
      agentName: 'proto',
      reasoning: ['Bullet kalır'],
    });
    render(
      <ExplanationPanel pipelineId="p-1" explanation={mkExplanation({ stages: [protoStage] })} />
    );
    expect(screen.queryByTestId('ac-coverage')).toBeNull();
    expect(screen.getByText('Bullet kalır')).toBeInTheDocument();
  });

  it('falls back to bullet list when acCoverage has zero AC', () => {
    const protoStage = mkStage({ agentName: 'proto', reasoning: ['Bullet kalır'] });
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [protoStage] })}
        acCoverage={{
          totalAcs: 0,
          staticCoveredCount: 0,
          dynamicCoveredCount: 0,
          items: [],
        }}
      />
    );
    expect(screen.queryByTestId('ac-coverage')).toBeNull();
    expect(screen.getByText('Bullet kalır')).toBeInTheDocument();
  });

  it('does NOT render the AC checklist on non-Proto stage cards', () => {
    const scribeStage = mkStage({ agentName: 'scribe', reasoning: ['Scribe bullet'] });
    render(
      <ExplanationPanel
        pipelineId="p-1"
        explanation={mkExplanation({ stages: [scribeStage] })}
        acCoverage={{
          totalAcs: 1,
          staticCoveredCount: 1,
          dynamicCoveredCount: 0,
          items: [
            {
              acId: 'ac-1',
              acDescription: 'x',
              staticCovered: true,
              dynamicCovered: false,
              coveringFiles: [],
              coveringTests: [],
            },
          ],
        }}
      />
    );
    expect(screen.queryByTestId('ac-coverage')).toBeNull();
    expect(screen.getByText('Scribe bullet')).toBeInTheDocument();
  });
});
