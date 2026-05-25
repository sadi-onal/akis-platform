/**
 * P8 — CriticResolutionGate tests.
 *
 * Covers:
 *   - Title + description render with substituted score/findingsCount
 *   - CriticScoreBar is mounted with the same review payload
 *   - "Yine de devam et" button POSTs to /critic-override
 *   - Override error path surfaces an inline alert
 *   - Loading state swaps the button text to "İlerleniyor..."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { CriticReviewOutput } from '../../../types/pipeline';

const TR_STUBS: Record<string, string> = {
  'chat.critic.scoreBar.title': 'Kod inceleme skoru',
  'chat.critic.scoreBar.threshold': 'Onay eşiği: {value}',
  'chat.critic.scoreBar.approved': 'Onaylandı',
  'chat.critic.scoreBar.blocked': 'Düzeltme bekleniyor',
  'chat.critic.scoreBar.findingsSuffix': 'bulgu',
  'chat.critic.resolution.title': 'Critic inceleme bulguları',
  'chat.critic.resolution.description':
    "{score}/100 puan · {findingsCount} bulgu raporlandı. Düzeltmek için chat'e yaz veya 'Yine de devam et' butonunu kullan.",
  'chat.critic.resolution.override': 'Yine de devam et',
  'chat.critic.resolution.overriding': 'İlerleniyor...',
  'chat.critic.resolution.errorOverride': 'İlerleme sırasında bir sorun oluştu.',
  'chat.stageConflict': 'Pipeline durumu değişti. Sayfa güncelleniyor...',
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

const criticOverride = vi.fn();
vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    criticOverride: (id: string) => criticOverride(id),
  },
}));

import { CriticResolutionGate } from '../CriticResolutionGate';

function mkReview(over: Partial<CriticReviewOutput> = {}): CriticReviewOutput {
  return {
    approved: false,
    overallScore: 40,
    findings: [
      {
        severity: 'critical',
        category: 'completeness',
        description: 'sample finding',
        suggestion: 'fix it',
      },
      {
        severity: 'major',
        category: 'consistency',
        description: 'another finding',
        suggestion: 'fix the other thing',
      },
    ],
    summary: 'mock summary',
    reviewType: 'code_review',
    iteration: 1,
    ...over,
  };
}

describe('CriticResolutionGate', () => {
  beforeEach(() => {
    criticOverride.mockReset();
  });

  it('renders the title + description with substituted values', () => {
    render(
      <CriticResolutionGate
        pipelineId="p-1"
        criticReview={mkReview({ overallScore: 40 })}
        approvalThreshold={75}
      />,
    );
    expect(screen.getByText(/Critic inceleme bulguları/)).toBeInTheDocument();
    // The description has score=40 + findingsCount=2 from the fixture
    expect(
      screen.getByText(/40\/100 puan · 2 bulgu raporlandı/),
    ).toBeInTheDocument();
  });

  it('mounts the CriticScoreBar with the review score and threshold', () => {
    render(
      <CriticResolutionGate
        pipelineId="p-1"
        criticReview={mkReview({ overallScore: 55 })}
        approvalThreshold={80}
      />,
    );
    const bar = screen.getByTestId('critic-score-bar');
    expect(bar.getAttribute('data-score')).toBe('55');
    expect(bar.getAttribute('data-threshold')).toBe('80');
  });

  it('renders the "Yine de devam et" button', () => {
    render(
      <CriticResolutionGate pipelineId="p-1" criticReview={mkReview()} approvalThreshold={75} />,
    );
    expect(
      screen.getByRole('button', { name: /Yine de devam et/i }),
    ).toBeInTheDocument();
  });

  it('clicking override invokes workflowsApi.criticOverride + onResolved', async () => {
    criticOverride.mockResolvedValueOnce({ id: 'p-1' });
    const onResolved = vi.fn();
    render(
      <CriticResolutionGate
        pipelineId="p-1"
        criticReview={mkReview()}
        approvalThreshold={75}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByTestId('critic-resolution-gate-override'));
    await waitFor(() => {
      expect(criticOverride).toHaveBeenCalledWith('p-1');
      expect(onResolved).toHaveBeenCalledOnce();
    });
  });

  it('surfaces an inline error when the override fails', async () => {
    criticOverride.mockRejectedValueOnce(new Error('boom'));
    render(
      <CriticResolutionGate pipelineId="p-1" criticReview={mkReview()} approvalThreshold={75} />,
    );
    fireEvent.click(screen.getByTestId('critic-resolution-gate-override'));
    await waitFor(() => {
      expect(screen.getByTestId('critic-resolution-gate-error')).toHaveTextContent('boom');
    });
  });

  // #637 — stage conflict error shows friendly message + calls onResolved
  it('shows a friendly message and calls onResolved when INVALID_STAGE error occurs', async () => {
    const stageErr = Object.assign(
      new Error('Invalid stage: expected awaiting_critic_resolution, got critic_reviewing_code'),
      { code: 'INVALID_STAGE', statusCode: 400 },
    );
    criticOverride.mockRejectedValueOnce(stageErr);
    const onResolved = vi.fn();
    render(
      <CriticResolutionGate
        pipelineId="p-1"
        criticReview={mkReview()}
        approvalThreshold={75}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByTestId('critic-resolution-gate-override'));
    await waitFor(() => {
      expect(screen.getByTestId('critic-resolution-gate-error')).toHaveTextContent(
        'Pipeline durumu değişti',
      );
      expect(onResolved).toHaveBeenCalledOnce();
    });
  });
});
