import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '../ErrorBoundary';

function renderWithRouter(ui: React.ReactElement) {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

// A component that throws on render
function ThrowingChild({ message = 'Test error' }: { message?: string }) {
  throw new Error(message);
}

// Suppress console.error noise from React error boundary internals
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    renderWithRouter(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('shows error UI when child throws', () => {
    renderWithRouter(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Bir hata olustu')).toBeInTheDocument();
  });

  it('shows error description', () => {
    renderWithRouter(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(
      screen.getByText(/Bu sayfa yüklenirken bir hata meydana geldi/)
    ).toBeInTheDocument();
  });

  it('shows Reload Page button', () => {
    renderWithRouter(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Sayfayı Yenile')).toBeInTheDocument();
  });

  it('shows Back to Chat link by default', () => {
    renderWithRouter(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    const link = screen.getByText(/Sohbet sayfasına dön/);
    expect(link.closest('a')?.getAttribute('href')).toBe('/chat');
  });

  it('shows custom fallback path and label', () => {
    renderWithRouter(
      <ErrorBoundary fallbackPath="/settings" fallbackLabel="Ayarlar">
        <ThrowingChild />
      </ErrorBoundary>
    );
    const link = screen.getByText(/Ayarlar sayfasına dön/);
    expect(link.closest('a')?.getAttribute('href')).toBe('/settings');
  });
});

// ─── redactSecrets logic (re-created from ErrorBoundary.tsx) ─────────

function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  redacted = redacted.replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_REDACTED');
  redacted = redacted.replace(/gho_[a-zA-Z0-9]{36}/g, 'gho_REDACTED');
  redacted = redacted.replace(/ghs_[a-zA-Z0-9]{36}/g, 'ghs_REDACTED');
  redacted = redacted.replace(/ghr_[a-zA-Z0-9]{36}/g, 'ghr_REDACTED');
  redacted = redacted.replace(/ghu_[a-zA-Z0-9]{36}/g, 'ghu_REDACTED');
  redacted = redacted.replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_REDACTED');
  redacted = redacted.replace(/ntn_[a-zA-Z0-9]{36}/g, 'ntn_REDACTED');
  redacted = redacted.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, 'JWT_REDACTED');
  return redacted;
}

describe('redactSecrets', () => {
  it('returns empty string for empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('leaves normal text unchanged', () => {
    expect(redactSecrets('An error occurred at line 42')).toBe('An error occurred at line 42');
  });

  it('redacts GitHub personal access tokens', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    expect(redactSecrets(`Error with token ${token}`)).toBe('Error with token ghp_REDACTED');
  });

  it('redacts GitHub OAuth tokens', () => {
    const token = 'gho_' + 'b'.repeat(36);
    expect(redactSecrets(token)).toBe('gho_REDACTED');
  });

  it('redacts GitHub server tokens', () => {
    const token = 'ghs_' + 'c'.repeat(36);
    expect(redactSecrets(token)).toBe('ghs_REDACTED');
  });

  it('redacts npm tokens', () => {
    const token = 'ntn_' + 'd'.repeat(36);
    expect(redactSecrets(token)).toBe('ntn_REDACTED');
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(`Token: ${jwt}`)).toBe('Token: JWT_REDACTED');
  });

  it('redacts multiple tokens in same string', () => {
    const ghp = 'ghp_' + 'x'.repeat(36);
    const gho = 'gho_' + 'y'.repeat(36);
    expect(redactSecrets(`${ghp} and ${gho}`)).toBe('ghp_REDACTED and gho_REDACTED');
  });
});
