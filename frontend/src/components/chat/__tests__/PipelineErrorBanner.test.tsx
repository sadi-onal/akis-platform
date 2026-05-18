import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PipelineErrorBanner } from '../PipelineErrorBanner';
import type { PipelineError } from '../../../types/pipeline';

// ── Fixtures ───────────────────────────────────────────────────────────────

const retryableError: PipelineError = {
  code: 'PROTO_PUSH_FAILED',
  message: 'GitHub\'a kod gönderilemedi. Lütfen bağlantınızı kontrol edin.',
  retryable: true,
  recoveryAction: 'retry',
};

const skipTraceError: PipelineError = {
  code: 'TRACE_TIMEOUT',
  message: 'Test yazımı zaman aşımına uğradı.',
  retryable: false,
  recoveryAction: 'skip-trace',
};

const nonRetryableError: PipelineError = {
  code: 'SPEC_INVALID',
  message: 'Spec geçersiz. Yeni bir sohbet başlatın.',
  retryable: false,
};

const reconnectGitHubError: PipelineError = {
  code: 'GITHUB_TOKEN_INVALID',
  message: "GitHub bağlantınızın süresi dolmuş veya geçersiz. Devam etmek için GitHub hesabınızı yeniden bağlayın.",
  retryable: false,
  recoveryAction: 'reconnect_github',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PipelineErrorBanner', () => {
  it('renders the error banner with friendly title and detail', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    // PROTO_PUSH_FAILED is NOT mapped in errorMessages (only AI/timeout/network
    // codes are), so the banner falls back to the generic title + raw message.
    expect(screen.getByText('Akış başarısız')).toBeInTheDocument();
    expect(screen.getByText(retryableError.message)).toBeInTheDocument();
  });

  it('displays the error code chip', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.getByText('PROTO_PUSH_FAILED')).toBeInTheDocument();
  });

  it('renders "Tekrar Dene" button when error is retryable', () => {
    render(<PipelineErrorBanner error={retryableError} onRetry={vi.fn()} />);

    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(screen.getByText('Tekrar Dene')).toBeInTheDocument();
  });

  it('calls onRetry when "Tekrar Dene" button is clicked', () => {
    const onRetry = vi.fn();
    render(<PipelineErrorBanner error={retryableError} onRetry={onRetry} />);

    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does NOT render retry button when retryable=false', () => {
    render(<PipelineErrorBanner error={nonRetryableError} onRetry={vi.fn()} />);

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('does NOT render retry button when onRetry is not provided', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('renders "Trace\'i Atla" button when recoveryAction is skip-trace', () => {
    render(<PipelineErrorBanner error={skipTraceError} onSkipTrace={vi.fn()} />);

    expect(screen.getByTestId('skip-trace-button')).toBeInTheDocument();
    expect(screen.getByText("Trace'i Atla")).toBeInTheDocument();
  });

  it('calls onSkipTrace when "Trace\'i Atla" button is clicked', () => {
    const onSkipTrace = vi.fn();
    render(<PipelineErrorBanner error={skipTraceError} onSkipTrace={onSkipTrace} />);

    fireEvent.click(screen.getByTestId('skip-trace-button'));
    expect(onSkipTrace).toHaveBeenCalledOnce();
  });

  it('does NOT render skip-trace button when recoveryAction differs', () => {
    render(<PipelineErrorBanner error={retryableError} onSkipTrace={vi.fn()} />);

    expect(screen.queryByTestId('skip-trace-button')).not.toBeInTheDocument();
  });

  it('does NOT render skip-trace button when onSkipTrace is not provided', () => {
    render(<PipelineErrorBanner error={skipTraceError} />);

    expect(screen.queryByTestId('skip-trace-button')).not.toBeInTheDocument();
  });

  it('renders neither button for non-retryable error with no recoveryAction', () => {
    render(
      <PipelineErrorBanner error={nonRetryableError} onRetry={vi.fn()} onSkipTrace={vi.fn()} />,
    );

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skip-trace-button')).not.toBeInTheDocument();
  });

  it('has role="alert" for accessibility', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('has data-testid="pipeline-error-banner"', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.getByTestId('pipeline-error-banner')).toBeInTheDocument();
  });

  it('renders both buttons when error has retryable=true and recoveryAction=skip-trace', () => {
    const bothError: PipelineError = {
      code: 'TRACE_PARTIAL_FAIL',
      message: 'Trace kısmen başarısız.',
      retryable: true,
      recoveryAction: 'skip-trace',
    };
    render(
      <PipelineErrorBanner error={bothError} onRetry={vi.fn()} onSkipTrace={vi.fn()} />,
    );

    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(screen.getByTestId('skip-trace-button')).toBeInTheDocument();
  });

  // ── reconnect-github (issue #485 / BUG-K) ────────────────────────────────

  it('renders "GitHub\'a Yeniden Bağlan" button when recoveryAction is reconnect-github', () => {
    render(<PipelineErrorBanner error={reconnectGitHubError} />);

    expect(screen.getByTestId('reconnect-github-button')).toBeInTheDocument();
    expect(screen.getByText("GitHub'a Yeniden Bağlan")).toBeInTheDocument();
  });

  it('"GitHub\'a Yeniden Bağlan" link points to /settings?tab=integrations', () => {
    render(<PipelineErrorBanner error={reconnectGitHubError} />);

    const link = screen.getByTestId('reconnect-github-button');
    expect(link).toHaveAttribute('href', '/settings?tab=integrations');
  });

  it('does NOT render "reconnect-github" button when recoveryAction is different', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.queryByTestId('reconnect-github-button')).not.toBeInTheDocument();
  });

  // ── retry-in-flight (#490 BUG-N) ─────────────────────────────────────────

  describe('#490 BUG-N — retry-in-flight state', () => {
    it('swaps the retry button with a disabled loader when isRetrying=true', () => {
      render(
        <PipelineErrorBanner error={retryableError} onRetry={vi.fn()} isRetrying />,
      );

      const button = screen.getByTestId('retry-button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByText('Yeniden deneniyor...')).toBeInTheDocument();
      expect(screen.queryByText('Tekrar Dene')).not.toBeInTheDocument();
    });

    it('does NOT call onRetry when the disabled retrying button is clicked', () => {
      const onRetry = vi.fn();
      render(
        <PipelineErrorBanner error={retryableError} onRetry={onRetry} isRetrying />,
      );

      fireEvent.click(screen.getByTestId('retry-button'));
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('renders the normal Tekrar Dene button when isRetrying is omitted (default false)', () => {
      render(<PipelineErrorBanner error={retryableError} onRetry={vi.fn()} />);

      const button = screen.getByTestId('retry-button');
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'false');
      expect(screen.getByText('Tekrar Dene')).toBeInTheDocument();
    });
  });

  // ── P11 — AI error severity classification ───────────────────────────────

  describe('P11 — AI error severity classification', () => {
    it('renders "AI sağlayıcısı yoğun" title for AI_RATE_LIMITED', () => {
      const rateError: PipelineError = {
        code: 'AI_RATE_LIMITED',
        message: 'rate limit exceeded',
        retryable: true,
        recoveryAction: 'retry',
      };
      render(<PipelineErrorBanner error={rateError} onRetry={vi.fn()} />);

      expect(screen.getByText('AI sağlayıcısı yoğun')).toBeInTheDocument();
      // Backend raw message must NOT live in the primary detail line (only
      // on the smaller technical-detail line). Assert by data-testid so a
      // text match on the technical line does not give a false negative.
      expect(screen.getByTestId('banner-detail')).not.toHaveTextContent(
        'rate limit exceeded',
      );
      // Banner severity attribute drives the warn (amber) palette.
      expect(screen.getByTestId('pipeline-error-banner')).toHaveAttribute(
        'data-error-severity',
        'warn',
      );
    });

    it('renders "AI kotası tükendi" title when AI_PROVIDER_ERROR carries insufficient-credits message', () => {
      const quotaError: PipelineError = {
        code: 'AI_PROVIDER_ERROR',
        message:
          'OpenAI account has insufficient credits. Please add credits or update your API key.',
        retryable: true,
        recoveryAction: 'retry',
      };
      render(<PipelineErrorBanner error={quotaError} onRetry={vi.fn()} />);

      expect(screen.getByText('AI kotası tükendi')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-error-banner')).toHaveAttribute(
        'data-error-severity',
        'error',
      );
    });

    it('renders "Zaman aşımı" title + Tekrar Dene button for TRACE_AI_CALL_TIMEOUT', () => {
      const timeoutError: PipelineError = {
        code: 'TRACE_AI_CALL_TIMEOUT',
        message: 'AI yanıt vermedi',
        retryable: true,
        recoveryAction: 'retry',
      };
      render(<PipelineErrorBanner error={timeoutError} onRetry={vi.fn()} />);

      expect(screen.getByText('Zaman aşımı')).toBeInTheDocument();
      expect(screen.getByTestId('retry-button')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-error-banner')).toHaveAttribute(
        'data-error-severity',
        'warn',
      );
    });

    it('renders "Ağ bağlantısı hatası" title for AI_NETWORK_ERROR', () => {
      const networkError: PipelineError = {
        code: 'AI_NETWORK_ERROR',
        message: 'fetch failed',
        retryable: true,
        recoveryAction: 'retry',
      };
      render(<PipelineErrorBanner error={networkError} onRetry={vi.fn()} />);

      expect(screen.getByText('Ağ bağlantısı hatası')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-error-banner')).toHaveAttribute(
        'data-error-severity',
        'error',
      );
    });

    it('falls back to raw backend message for an unknown code (regression-safe)', () => {
      const unknown: PipelineError = {
        code: 'SOMETHING_NEW_BACKEND_NEVER_SHIPPED',
        message: 'Beklenmedik backend hatası',
        retryable: false,
      };
      render(<PipelineErrorBanner error={unknown} />);

      expect(screen.getByText('Akış başarısız')).toBeInTheDocument();
      // The raw backend message is preserved as the detail line.
      expect(screen.getByText('Beklenmedik backend hatası')).toBeInTheDocument();
    });

    it('shows backend message as a small technical detail line when code is matched', () => {
      const rateError: PipelineError = {
        code: 'AI_RATE_LIMITED',
        message: 'AI provider openai is rate limited',
        retryable: true,
        recoveryAction: 'retry',
      };
      render(<PipelineErrorBanner error={rateError} onRetry={vi.fn()} />);

      // Technical line carries the raw backend message verbatim.
      expect(
        screen.getByTestId('banner-technical-detail'),
      ).toHaveTextContent('AI provider openai is rate limited');
    });

    it('does NOT render technical-detail line when fallback path is taken', () => {
      const unknown: PipelineError = {
        code: 'UNKNOWN_X',
        message: 'fallback detail',
        retryable: false,
      };
      render(<PipelineErrorBanner error={unknown} />);

      expect(
        screen.queryByTestId('banner-technical-detail'),
      ).not.toBeInTheDocument();
    });

    it('preserves the error code chip across friendly and fallback paths', () => {
      const rateError: PipelineError = {
        code: 'AI_RATE_LIMITED',
        message: 'x',
        retryable: true,
      };
      render(<PipelineErrorBanner error={rateError} />);

      expect(screen.getByText('AI_RATE_LIMITED')).toBeInTheDocument();
    });

    it('keeps reconnect-github recoveryAction working with the new friendly title', () => {
      render(<PipelineErrorBanner error={reconnectGitHubError} />);

      // Friendly title from the helper map.
      expect(
        screen.getByText('GitHub bağlantısının süresi doldu'),
      ).toBeInTheDocument();
      // Reconnect button still wired.
      expect(
        screen.getByTestId('reconnect-github-button'),
      ).toBeInTheDocument();
    });
  });
});
