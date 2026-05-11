/**
 * SignupEmail — Auth signup (step 1) tests
 *
 * Covers:
 *  - Smoke render (OAuth buttons + form fields + link to /login)
 *  - Form submit happy path → signupStart called + sessionStorage written + navigate
 *  - JSON & plain-text + non-Error fallback error paths
 *  - OAuth button click → window.location.href set
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockSignupStart = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    signupStart: (data: { firstName: string; lastName: string; email: string }) =>
      mockSignupStart(data),
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

import SignupEmail from '../SignupEmail';

function renderSignupEmail() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupEmail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const originalLocation = window.location;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href: '' } as Location,
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe('SignupEmail — rendering', () => {
  it('renders OAuth Google and GitHub buttons', () => {
    renderSignupEmail();
    expect(screen.getByLabelText('auth.oauth.google')).toBeInTheDocument();
    expect(screen.getByLabelText('auth.oauth.github')).toBeInTheDocument();
  });

  it('renders firstName, lastName, email fields', () => {
    renderSignupEmail();
    expect(screen.getByLabelText('auth.firstName.label')).toBeInTheDocument();
    expect(screen.getByLabelText('auth.lastName.label')).toBeInTheDocument();
    expect(screen.getByLabelText('auth.email.label')).toBeInTheDocument();
  });

  it('renders title + subtitle + sign-in link', () => {
    renderSignupEmail();
    expect(screen.getByText('auth.signup.title')).toBeInTheDocument();
    expect(screen.getByText('auth.signup.subtitle')).toBeInTheDocument();
    const link = screen.getByText('auth.signup.signIn');
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders the continue button', () => {
    renderSignupEmail();
    expect(
      screen.getByRole('button', { name: 'auth.signup.continue' }),
    ).toBeInTheDocument();
  });
});

describe('SignupEmail — form submission', () => {
  it('calls signupStart, writes sessionStorage, navigates to /signup/password', async () => {
    mockSignupStart.mockResolvedValueOnce({
      userId: 'u1',
      email: 'a@b.com',
      message: 'ok',
      status: 'pending_verification',
    });
    renderSignupEmail();

    fireEvent.change(screen.getByLabelText('auth.firstName.label'), {
      target: { value: 'Ali' },
    });
    fireEvent.change(screen.getByLabelText('auth.lastName.label'), {
      target: { value: 'Yılmaz' },
    });
    fireEvent.change(screen.getByLabelText('auth.email.label'), {
      target: { value: 'a@b.com' },
    });

    fireEvent.submit(screen.getByLabelText('auth.email.label').closest('form')!);

    await vi.waitFor(() => {
      expect(mockSignupStart).toHaveBeenCalledWith({
        firstName: 'Ali',
        lastName: 'Yılmaz',
        email: 'a@b.com',
      });
    });

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/signup/password');
    });

    const stored = JSON.parse(sessionStorage.getItem('akis_signup_data') || '{}');
    expect(stored).toMatchObject({
      userId: 'u1',
      firstName: 'Ali',
      lastName: 'Yılmaz',
      email: 'a@b.com',
    });
  });

  it('shows the plain error message when AuthAPI throws', async () => {
    mockSignupStart.mockRejectedValueOnce(new Error('boom!'));
    renderSignupEmail();
    fireEvent.change(screen.getByLabelText('auth.firstName.label'), {
      target: { value: 'A' },
    });
    fireEvent.change(screen.getByLabelText('auth.lastName.label'), {
      target: { value: 'B' },
    });
    fireEvent.change(screen.getByLabelText('auth.email.label'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.submit(screen.getByLabelText('auth.email.label').closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('boom!')).toBeInTheDocument();
    });
  });

  it('parses a structured JSON error and shows its error field', async () => {
    mockSignupStart.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: 'E-posta zaten kullanılıyor' })),
    );
    renderSignupEmail();
    fireEvent.change(screen.getByLabelText('auth.firstName.label'), {
      target: { value: 'A' },
    });
    fireEvent.change(screen.getByLabelText('auth.lastName.label'), {
      target: { value: 'B' },
    });
    fireEvent.change(screen.getByLabelText('auth.email.label'), {
      target: { value: 'taken@example.com' },
    });
    fireEvent.submit(screen.getByLabelText('auth.email.label').closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('E-posta zaten kullanılıyor')).toBeInTheDocument();
    });
  });

  it('falls back to default Turkish error when rejection is not an Error', async () => {
    mockSignupStart.mockRejectedValueOnce('weird');
    renderSignupEmail();
    fireEvent.change(screen.getByLabelText('auth.firstName.label'), {
      target: { value: 'A' },
    });
    fireEvent.change(screen.getByLabelText('auth.lastName.label'), {
      target: { value: 'B' },
    });
    fireEvent.change(screen.getByLabelText('auth.email.label'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.submit(screen.getByLabelText('auth.email.label').closest('form')!);
    await vi.waitFor(() => {
      expect(
        screen.getByText('Hesap olusturulamadi. Lutfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });
});

describe('SignupEmail — OAuth', () => {
  it('redirects to Google OAuth on click', () => {
    renderSignupEmail();
    fireEvent.click(screen.getByLabelText('auth.oauth.google'));
    expect(window.location.href).toBe('http://test.local/auth/oauth/google');
  });

  it('redirects to GitHub OAuth on click', () => {
    renderSignupEmail();
    fireEvent.click(screen.getByLabelText('auth.oauth.github'));
    expect(window.location.href).toBe('http://test.local/auth/oauth/github');
  });
});
