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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PipelineErrorBanner', () => {
  it('renders the error banner with title and message', () => {
    render(<PipelineErrorBanner error={retryableError} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Pipeline başarısız')).toBeInTheDocument();
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
});
