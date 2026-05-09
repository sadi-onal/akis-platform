import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GithubConnectGate } from '../GithubConnectGate';
import { PENDING_GITHUB_IDEA_KEY } from '../githubConnectStorage';

describe('GithubConnectGate', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders permission bullets and the pending idea quoted', () => {
    render(
      <GithubConnectGate
        pendingIdea="dükkanım için stok takibi uygulaması"
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Devam etmek için GitHub'ı bağla/)).toBeInTheDocument();
    expect(screen.getByText(/Senin için yeni bir depo açar/)).toBeInTheDocument();
    expect(screen.getByText(/Yazdığı kodu o depoya gönderir/)).toBeInTheDocument();
    expect(screen.getByText(/Mevcut depolarına dokunmaz/)).toBeInTheDocument();
    expect(
      screen.getByTestId('github-connect-gate-pending-idea').textContent,
    ).toContain('dükkanım için stok takibi uygulaması');
  });

  it('connect button persists idea to sessionStorage and redirects to OAuth start', () => {
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        get href() {
          return originalLocation.href;
        },
        set href(value: string) {
          hrefSetter(value);
        },
      },
    });

    try {
      render(
        <GithubConnectGate pendingIdea="my idea" onCancel={() => {}} />,
      );
      fireEvent.click(screen.getByTestId('github-connect-gate-connect'));
      expect(sessionStorage.getItem(PENDING_GITHUB_IDEA_KEY)).toBe('my idea');
      expect(hrefSetter).toHaveBeenCalledWith('/api/integrations/github/oauth/start');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('connect button shows "yönlendiriliyorsun" loading state once clicked', () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        set href(_value: string) {
          /* swallow navigation */
        },
        get href() {
          return originalLocation.href;
        },
      },
    });

    try {
      render(<GithubConnectGate pendingIdea={'x'.repeat(15)} onCancel={() => {}} />);
      const button = screen.getByTestId('github-connect-gate-connect');
      fireEvent.click(button);
      expect(button.textContent).toMatch(/yönlendiriliyorsun/);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('cancel button calls onCancel without touching sessionStorage', () => {
    const onCancel = vi.fn();
    render(<GithubConnectGate pendingIdea="x" onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('github-connect-gate-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(PENDING_GITHUB_IDEA_KEY)).toBeNull();
  });
});
