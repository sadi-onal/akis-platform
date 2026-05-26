import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ChatMessage now uses useI18n — mock it so tests render without I18nProvider.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const msgs: Record<string, string> = {
        'chat.message.testPlanAiEstimate': 'Test Planı (AI Tahmini)',
        'chat.message.testPlanAiEstimateNote':
          'Bu veriler Trace\'in AI tahminidir, gerçek test koşturma sonucu değildir.',
        'chat.message.testPlanPassed': 'başarılı',
        'chat.message.testPlanFailed': 'başarısız',
        'chat.message.testPlanCoverage': 'kapsam',
        'chat.message.testHelperFiles': 'Test ve yardımcı dosyalar',
        'chat.message.testHelperLabel': 'yardımcı',
        'chat.message.testCriteriaNotCovered': 'kriter kapsanmadı',
        'chat.message.testSteps': 'adım',
        'chat.message.testIteration': 'İterasyon',
      };
      return msgs[key] ?? key;
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { ChatMessage } from '../ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../../types/chat';

// Mock PlanCard — same approach as ChatMessage.test.tsx
vi.mock('../PlanCard', () => ({
  PlanCard: ({
    plan,
    status,
  }: {
    plan: { projectName?: string };
    version: number;
    status: string;
    isChangeRequest: boolean;
  }) => (
    <div
      data-testid="plan-card"
      data-status={status}
      data-project={'projectName' in plan ? plan.projectName : ''}
    >
      PlanCard mock: {plan.projectName}
    </div>
  ),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

// Mock formatDuration — returns Turkish-like strings for testing
vi.mock('../../../utils/formatDuration', () => ({
  formatDuration: (ms: number | undefined | null) => {
    if (ms == null || ms < 0) return '';
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds} sn`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainderSec = totalSeconds - totalMinutes * 60;
    if (remainderSec < 5) return `${totalMinutes} dk`;
    return `${totalMinutes} dk ${remainderSec} sn`;
  },
}));

// Mock useRelativeDuration — not needed for completed bubbles
vi.mock('../../../hooks/useRelativeDuration', () => ({
  useRelativeDuration: () => '',
}));

describe('ChatMessage — agent narrator (2026-05-23)', () => {
  it('renders LLM summary as the body of the agent bubble', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'fallback',
      summary: 'Sayaç için 5 user story belirledim.',
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Sayaç için 5 user story belirledim/)).toBeInTheDocument();
  });

  it('renders embedded PlanCard inside Scribe bubble', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: '',
      summary: 'Plan hazır.',
      timestamp: new Date().toISOString(),
      embeddedPlan: {
        plan: {
          projectName: 'Sayaç',
          summary: '',
          features: [],
          techChoices: [],
          estimatedFiles: 5,
          requiresTests: true,
        },
        version: 1,
        status: 'active',
      },
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Sayaç/)).toBeInTheDocument();
    expect(screen.getByTestId('plan-card')).toBeInTheDocument();
  });

  it('renders duration footer when durationMs is set', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      durationMs: 98000,
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/1 dk 38 sn/)).toBeInTheDocument();
  });

  it('does NOT render duration when durationMs missing (NF-2)', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    // Verify no 'dk' / 'sn' / 'sa' text leaked through
    expect(screen.queryByText(/dk|sn|sa\b/)).toBeNull();
  });

  it('renders collapsed sub-step toggle when subSteps present', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      timestamp: new Date().toISOString(),
      subSteps: [
        { label: 'İskelet üretildi', status: 'done', source: 'agent' },
        {
          label: 'Statik kontrol: ✓ temiz',
          status: 'done',
          source: 'validator',
        },
      ],
    };
    const { container } = render(<ChatMessage message={msg} />);
    // Toggle label: "2 adım"
    expect(screen.getByText(/2 adım/)).toBeInTheDocument();
    // Default collapsed — <details> should NOT have the `open` attribute.
    // (jsdom renders child content regardless of open state, so we check
    // the attribute instead of querying child text.)
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('falls back to content when summary is missing', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'Fallback içerik.',
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Fallback içerik/)).toBeInTheDocument();
  });
});
