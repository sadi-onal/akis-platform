import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TraceFailureMessage } from '../TraceFailureMessage';

// Identity-translator so we can assert on i18n keys / final strings without
// loading the real locale catalog. The project ships a custom i18n provider
// (frontend/src/i18n/useI18n.ts) — NOT react-i18next.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      // Return Turkish strings so tests can assert on user-facing copy.
      const tr: Record<string, string> = {
        'chat.trace_failure.timeout_title': 'İşlem zaman aşımına uğradı',
        'chat.trace_failure.error_title': 'Test yazımı tamamlanamadı',
        'chat.trace_failure.retry': 'Tekrar Dene',
        'chat.trace_failure.skip': "Trace'siz devam et",
      };
      return tr[key] ?? key;
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

describe('TraceFailureMessage', () => {
  it('shows timeout title when errorCode=PIPELINE_TIMEOUT', () => {
    render(
      <TraceFailureMessage
        errorCode="PIPELINE_TIMEOUT"
        errorMessage="Test yazımı 15 dakika yanıt vermedi."
        recoveryAction="retry"
        onRetry={vi.fn()}
        onSkipTrace={vi.fn()}
      />
    );
    expect(screen.getByText(/zaman aşımına uğradı/i)).toBeInTheDocument();
    expect(screen.getByText(/15 dakika yanıt vermedi/)).toBeInTheDocument();
  });

  it('shows error title when errorCode is non-timeout', () => {
    render(
      <TraceFailureMessage
        errorCode="AI_PROVIDER_ERROR"
        errorMessage="Rate limit exceeded"
        recoveryAction="retry"
        onRetry={vi.fn()}
        onSkipTrace={vi.fn()}
      />
    );
    expect(screen.getByText(/tamamlanamadı/i)).toBeInTheDocument();
    expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
  });

  it("renders Tekrar Dene + Trace'siz devam et buttons when recoveryAction=retry", () => {
    const onRetry = vi.fn();
    const onSkipTrace = vi.fn();
    render(
      <TraceFailureMessage
        errorCode="PIPELINE_TIMEOUT"
        errorMessage="t"
        recoveryAction="retry"
        onRetry={onRetry}
        onSkipTrace={onSkipTrace}
      />
    );
    const retryBtn = screen.getByRole('button', { name: /Tekrar Dene/i });
    // Skip button has a verbose aria-label for screen readers ("Trace
    // adımını atla…"). Match it by its visible label / testid instead.
    const skipBtn = screen.getByTestId('trace-failure-skip-button');
    expect(skipBtn).toHaveTextContent(/Trace'siz devam et/i);

    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(skipBtn);
    expect(onSkipTrace).toHaveBeenCalledTimes(1);
  });

  it('hides buttons when recoveryAction is undefined', () => {
    render(
      <TraceFailureMessage
        errorCode="PIPELINE_TIMEOUT"
        errorMessage="t"
        onRetry={vi.fn()}
        onSkipTrace={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /Tekrar Dene/i })).toBeNull();
    expect(screen.queryByTestId('trace-failure-skip-button')).toBeNull();
    expect(screen.queryByTestId('trace-failure-retry-button')).toBeNull();
  });
});
