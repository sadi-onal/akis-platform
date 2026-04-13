import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastContainer, toast } from '../Toast';

// Mock crypto.randomUUID
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Date.now()}-${Math.random()}` });

describe('ToastContainer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no toasts exist', () => {
    const { container } = render(<ToastContainer />);
    expect(container.innerHTML).toBe('');
  });

  it('renders toast message after toast() call', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Operation successful', 'success');
    });
    expect(screen.getByText('Operation successful')).toBeInTheDocument();
  });

  it('applies correct variant styling for error', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Something went wrong', 'error');
    });
    const toastEl = screen.getByText('Something went wrong').closest('[role] > div') ?? screen.getByText('Something went wrong').parentElement;
    expect(toastEl?.className).toContain('text-red-400');
  });

  it('applies correct variant styling for warning', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Be careful', 'warning');
    });
    const toastEl = screen.getByText('Be careful').closest('[role] > div') ?? screen.getByText('Be careful').parentElement;
    expect(toastEl?.className).toContain('text-yellow-400');
  });

  it('defaults to info variant', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Info message');
    });
    const toastEl = screen.getByText('Info message').closest('[role] > div') ?? screen.getByText('Info message').parentElement;
    expect(toastEl?.className).toContain('text-blue-400');
  });

  it('renders multiple toasts', () => {
    render(<ToastContainer />);
    act(() => {
      toast('First', 'info');
      toast('Second', 'success');
    });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('has role="status" and aria-live="polite"', () => {
    render(<ToastContainer />);
    act(() => {
      toast('Accessible toast', 'info');
    });
    const container = screen.getByRole('status');
    expect(container).toHaveAttribute('aria-live', 'polite');
  });

  it('auto-dismisses toast after timeout', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastContainer />);
    act(() => {
      toast('Temporary', 'info');
    });
    expect(screen.getByText('Temporary')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('Temporary')).toBeNull();
    vi.useRealTimers();
  });
});
