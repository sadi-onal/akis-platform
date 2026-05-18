/**
 * PR-F — CriticFindingsInline tests.
 *
 * Critic guardrail mode: bulgular Proto kartının altında inline gösterilir.
 *
 * Covers:
 *   - findings boş ise component hiçbir şey render etmez (null)
 *   - findings dolu ise severity rozeti + bulgu sayısı görünür
 *   - "Uygula" akışı (ExplanationPanel'in CriticFindingsSection'ı reused)
 *     checkbox + button kombinasyonunu sergiler ve iterateWithFeedback'i tetikler
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { CriticReviewOutput } from '../../../types/pipeline';

const TR_STUBS: Record<string, string> = {
  'chat.critic.resolution.title': 'Critic inceleme bulguları',
  'chat.criticFindings.checkbox.aria': 'Bu öneriyi uygulanacak listeye ekle',
  'chat.criticFindings.selectedCount': '{n}/{total} öneri seçildi',
  'chat.criticFindings.applySelected': 'Seçilenleri uygula',
  'chat.criticFindings.applying': 'Uygulanıyor...',
  'chat.criticFindings.feedbackHeader': 'Aşağıdaki Critic önerileri uygulansın:',
  'chat.criticFindings.applyError': 'Düzeltme gönderilemedi.',
};

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => TR_STUBS[key] ?? key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { CriticFindingsInline } from '../CriticFindingsInline';

function mkReview(over: Partial<CriticReviewOutput> = {}): CriticReviewOutput {
  return {
    approved: false,
    overallScore: 60,
    findings: [
      {
        severity: 'major',
        category: 'completeness',
        description: 'Bazı kullanıcı hikayeleri eksik',
        suggestion: 'Kalan persona için story ekleyin',
      },
      {
        severity: 'minor',
        category: 'ambiguity',
        description: 'Şu kabul kriteri net değil',
        suggestion: 'Daha somut hale getirin',
      },
    ],
    summary: 'Birkaç düzeltme öneriliyor',
    reviewType: 'code_review',
    iteration: 1,
    hasCriticalFinding: false,
    maxSeverity: 'major',
    ...over,
  };
}

describe('CriticFindingsInline (PR-F)', () => {
  it('renders nothing when criticReview is undefined', () => {
    const { container } = render(
      <CriticFindingsInline pipelineId="p-1" criticReview={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when findings array is empty', () => {
    const { container } = render(
      <CriticFindingsInline
        pipelineId="p-1"
        criticReview={mkReview({ findings: [] })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders severity badge + finding count', () => {
    render(
      <CriticFindingsInline
        pipelineId="p-1"
        criticReview={mkReview()}
      />,
    );
    const root = screen.getByTestId('critic-findings-inline');
    expect(root).toBeInTheDocument();
    expect(root.getAttribute('data-max-severity')).toBe('major');
    // Header chip wording: "2 bulgu · Önemli"
    expect(root.textContent).toContain('2 bulgu');
    expect(root.textContent).toContain('Önemli');
  });

  it('shows critical chip styling when hasCriticalFinding=true', () => {
    const review = mkReview({
      maxSeverity: 'critical',
      hasCriticalFinding: true,
      findings: [
        {
          severity: 'critical',
          category: 'security',
          description: 'Şifre düz metin tutuluyor',
          suggestion: 'Şifreyi hash\'le',
        },
      ],
    });
    render(<CriticFindingsInline pipelineId="p-1" criticReview={review} />);
    const root = screen.getByTestId('critic-findings-inline');
    expect(root.getAttribute('data-max-severity')).toBe('critical');
    expect(root.textContent).toContain('Kritik');
  });

  it('triggers iterateWithFeedback when "Uygula" pressed with selection', async () => {
    const iterateMock = vi.fn().mockResolvedValue(undefined);
    render(
      <CriticFindingsInline
        pipelineId="p-1"
        criticReview={mkReview()}
        iterateWithFeedback={iterateMock}
      />,
    );

    // Pick the first eligible suggestion.
    const checkbox = screen.getAllByRole('checkbox')[0];
    expect(checkbox).toBeDefined();
    fireEvent.click(checkbox!);

    // Then click apply.
    const applyBtn = screen.getByTestId('critic-findings-apply-button');
    fireEvent.click(applyBtn);

    await waitFor(() => expect(iterateMock).toHaveBeenCalled());
    const [pipelineId, feedback] = iterateMock.mock.calls[0]!;
    expect(pipelineId).toBe('p-1');
    expect(typeof feedback).toBe('string');
    expect(feedback).toContain('Kalan persona için story ekleyin');
  });

  it('derives maxSeverity client-side when backend omits the field (backward-compat)', () => {
    const review = mkReview();
    delete (review as Partial<CriticReviewOutput>).maxSeverity;
    render(<CriticFindingsInline pipelineId="p-1" criticReview={review} />);
    const root = screen.getByTestId('critic-findings-inline');
    // findings array has major+minor → max is "major"
    expect(root.getAttribute('data-max-severity')).toBe('major');
  });
});
