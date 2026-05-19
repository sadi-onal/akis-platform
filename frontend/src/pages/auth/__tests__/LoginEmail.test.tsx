/**
 * LoginEmail — Auth login (step 1) tests
 *
 * Covers:
 *  - Smoke render (OAuth buttons, email form, "Sign Up" link)
 *  - Form submit happy path → AuthAPI.loginStart called, sessionStorage written, navigate('/login/password')
 *  - API error (string) → error message rendered
 *  - API error EMAIL_NOT_VERIFIED → navigates to verify-email after delay
 *  - OAuth button clicks → window.location.href set
 *  - OAuth error banner from ?error=oauth_failed URL param + dismiss
 *  - Generic / unknown OAuth error code
 *  - Stale-return-to handling when no location state from
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ---- Mocks ----

const mockNavigate = vi.fn();
const mockSetReturnTo = vi.fn();
const mockClearReturnTo = vi.fn();

let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn((next: URLSearchParams) => {
  mockSearchParams = next;
});
let mockLocationState: unknown = null;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/login', state: mockLocationState }),
    useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  };
});

vi.mock('../../../utils/returnTo', () => ({
  setReturnTo: (path: string) => mockSetReturnTo(path),
  clearReturnTo: () => mockClearReturnTo(),
}));

const mockLoginStart = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    loginStart: (data: { email: string }) => mockLoginStart(data),
  },
}));

vi.mock('../../../services/api/config', () => ({
  getAuthBaseUrl: () => 'http://test.local',
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready' as const,
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/mock-logo.svg',
}));

// jsdom doesn't allow setting window.location.href to absolute URLs
// so we replace it with a writable stub.
const originalLocation = window.location;
beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  mockLocationState = null;
  // Stub navigation so handleOAuthLogin doesn't blow up jsdom
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href: '' } as Location,
  });
  sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

// ---- Helper ----

import LoginEmail from '../LoginEmail';

function renderLoginEmail() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginEmail />} />
      </Routes>
    </MemoryRouter>
  );
}

// ---- Tests ----

describe('LoginEmail — rendering', () => {
  it('renders OAuth Google + GitHub buttons', () => {
    renderLoginEmail();
    expect(screen.getByLabelText('auth.oauth.google')).toBeInTheDocument();
    expect(screen.getByLabelText('auth.oauth.github')).toBeInTheDocument();
  });

  it('renders the email input field', () => {
    renderLoginEmail();
    const input = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('email');
  });

  it('renders the "continue" submit button', () => {
    renderLoginEmail();
    expect(screen.getByRole('button', { name: 'auth.login.continue' })).toBeInTheDocument();
  });

  it('renders title + subtitle', () => {
    renderLoginEmail();
    expect(screen.getByText('auth.login.title')).toBeInTheDocument();
    expect(screen.getByText('auth.login.subtitle')).toBeInTheDocument();
  });

  it('renders a link to /signup with the "sign up" label', () => {
    renderLoginEmail();
    const link = screen.getByText('auth.login.signUp');
    expect(link).toHaveAttribute('href', '/signup');
  });

  it('clears returnTo on mount when no location.state.from is present', () => {
    mockLocationState = null;
    renderLoginEmail();
    expect(mockClearReturnTo).toHaveBeenCalled();
  });

  it('sets returnTo from location.state.from when provided', () => {
    mockLocationState = { from: { pathname: '/chat/protected' } };
    renderLoginEmail();
    expect(mockSetReturnTo).toHaveBeenCalledWith('/chat/protected');
  });
});

describe('LoginEmail — form submission', () => {
  it('calls AuthAPI.loginStart with the email and navigates to /login/password on success', async () => {
    mockLoginStart.mockResolvedValueOnce({
      userId: 'u1',
      email: 'user@example.com',
      requiresPassword: true,
      status: 'active',
    });

    renderLoginEmail();

    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'user@example.com' } });

    const form = emailInput.closest('form')!;
    fireEvent.submit(form);

    await vi.waitFor(() => {
      expect(mockLoginStart).toHaveBeenCalledWith({ email: 'user@example.com' });
    });

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login/password');
    });

    const stored = JSON.parse(sessionStorage.getItem('akis_login_data') || '{}');
    expect(stored).toMatchObject({ userId: 'u1', email: 'user@example.com' });
  });

  it('shows plain-text error message when AuthAPI throws a non-JSON error', async () => {
    mockLoginStart.mockRejectedValueOnce(new Error('Boom!'));

    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'user@example.com' } });
    fireEvent.submit(emailInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Boom!')).toBeInTheDocument();
    });
  });

  it('parses JSON error.message field when AuthAPI throws structured JSON', async () => {
    mockLoginStart.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: 'Kullanıcı bulunamadı' }))
    );

    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'missing@example.com' } });
    fireEvent.submit(emailInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Kullanıcı bulunamadı')).toBeInTheDocument();
    });
  });

  it('redirects to /signup/verify-email when API returns EMAIL_NOT_VERIFIED', async () => {
    mockLoginStart.mockRejectedValueOnce(
      new Error(JSON.stringify({ code: 'EMAIL_NOT_VERIFIED', userId: 'u9', message: 'verify' }))
    );

    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'unverified@example.com' } });
    fireEvent.submit(emailInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText(/E-posta doğrulanmadı/)).toBeInTheDocument();
    });

    // sessionStorage should contain signup data for the redirect step
    const stored = JSON.parse(sessionStorage.getItem('akis_signup_data') || '{}');
    expect(stored).toMatchObject({ userId: 'u9', email: 'unverified@example.com' });

    // Advance the setTimeout(2000) to fire the navigation
    await vi.advanceTimersByTimeAsync(2100);
    expect(mockNavigate).toHaveBeenCalledWith('/signup/verify-email');
  });

  it('falls back to default Turkish message when error has no message', async () => {
    // Throw a non-Error so the `err instanceof Error` branch is false
    mockLoginStart.mockRejectedValueOnce('weird-string-error');

    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'a@b.c' } });
    fireEvent.submit(emailInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Devam edilemiyor. Lütfen tekrar deneyin.')).toBeInTheDocument();
    });
  });
});

describe('LoginEmail — Enter key', () => {
  it('submits the form when Enter is pressed in the email input', async () => {
    mockLoginStart.mockResolvedValueOnce({
      userId: 'u1',
      email: 'enter@example.com',
      requiresPassword: true,
      status: 'active',
    });

    renderLoginEmail();

    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'enter@example.com' } });
    fireEvent.keyDown(emailInput, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(mockLoginStart).toHaveBeenCalledWith({ email: 'enter@example.com' });
    });
  });

  it('does not submit on Enter when the email field is empty', () => {
    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.keyDown(emailInput, { key: 'Enter' });
    expect(mockLoginStart).not.toHaveBeenCalled();
  });

  it('does not submit on non-Enter keys (e.g. Shift)', () => {
    renderLoginEmail();
    const emailInput = screen.getByLabelText('auth.email.label') as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'x@y.z' } });
    fireEvent.keyDown(emailInput, { key: 'Shift' });
    expect(mockLoginStart).not.toHaveBeenCalled();
  });
});

describe('LoginEmail — OAuth', () => {
  it('redirects to the Google OAuth endpoint when Google button clicked', () => {
    renderLoginEmail();
    fireEvent.click(screen.getByLabelText('auth.oauth.google'));
    expect(window.location.href).toBe('http://test.local/auth/oauth/google');
  });

  it('redirects to the GitHub OAuth endpoint when GitHub button clicked', () => {
    renderLoginEmail();
    fireEvent.click(screen.getByLabelText('auth.oauth.github'));
    expect(window.location.href).toBe('http://test.local/auth/oauth/github');
  });

  it('sets returnTo before redirecting when location.state.from is set', () => {
    mockLocationState = { from: { pathname: '/chat/secret' } };
    renderLoginEmail();
    // Clear previous calls from the mount-time effect
    mockSetReturnTo.mockClear();
    fireEvent.click(screen.getByLabelText('auth.oauth.google'));
    expect(mockSetReturnTo).toHaveBeenCalledWith('/chat/secret');
  });
});

describe('LoginEmail — OAuth error banner', () => {
  it('renders a mapped OAuth error from ?error=oauth_invalid_state', () => {
    mockSearchParams = new URLSearchParams('error=oauth_invalid_state');
    renderLoginEmail();
    expect(screen.getByText('auth.oauth.error.invalidState')).toBeInTheDocument();
    // mapping path: searchParams is cleared via setSearchParams
    expect(mockSetSearchParams).toHaveBeenCalled();
  });

  it('renders a generic provider-error for unknown oauth_* error codes', () => {
    mockSearchParams = new URLSearchParams('error=oauth_brand_new_failure');
    renderLoginEmail();
    expect(screen.getByText('auth.oauth.error.providerError')).toBeInTheDocument();
  });

  it('renders a generic error for non-oauth_ prefixed unknown error codes', () => {
    mockSearchParams = new URLSearchParams('error=mystery');
    renderLoginEmail();
    expect(screen.getByText('auth.oauth.error.generic')).toBeInTheDocument();
  });

  it('dismiss button hides the OAuth error banner', () => {
    mockSearchParams = new URLSearchParams('error=oauth_failed');
    renderLoginEmail();
    expect(screen.getByText('auth.oauth.error.failed')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('auth.oauth.error.dismiss'));
    // setState is synchronous in act() so the banner should be gone immediately
    expect(screen.queryByText('auth.oauth.error.failed')).not.toBeInTheDocument();
  });
});
