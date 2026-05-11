/**
 * LoginPassword — Auth login (step 2) tests
 *
 * Covers:
 *  - Renders nothing (null) when sessionStorage has no login data
 *  - Renders the password form, shows email from storage, back button
 *  - Submit happy path: AuthAPI.loginComplete → setUser + navigate to POST_AUTH_PATH
 *  - Honours returnTo path from sessionStorage when present
 *  - Show/Hide password toggle
 *  - Plain-text + JSON error paths
 *  - Back button navigates to /login
 *  - Corrupt sessionStorage data → cleared + redirected to /login
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ---- Mocks ----

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockSetUser = vi.fn();
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, setUser: mockSetUser }),
}));

const mockLoginComplete = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    loginComplete: (data: { userId: string; password: string }) =>
      mockLoginComplete(data),
  },
}));

const mockGetReturnTo = vi.fn();
const mockClearReturnTo = vi.fn();
vi.mock('../../../utils/returnTo', () => ({
  getReturnTo: () => mockGetReturnTo(),
  clearReturnTo: () => mockClearReturnTo(),
}));

vi.mock('../../../theme/brand', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../theme/brand');
  return { ...actual };
});

import LoginPassword from '../LoginPassword';

function renderLoginPassword() {
  return render(
    <MemoryRouter initialEntries={['/login/password']}>
      <Routes>
        <Route path="/login/password" element={<LoginPassword />} />
      </Routes>
    </MemoryRouter>,
  );
}

const VALID_STORAGE = JSON.stringify({ email: 'user@example.com', userId: 'u1' });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

// ---- Tests ----

describe('LoginPassword — guard rails', () => {
  it('redirects to /login when sessionStorage has no login data', () => {
    renderLoginPassword();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('clears + redirects to /login when sessionStorage data is malformed JSON', () => {
    sessionStorage.setItem('akis_login_data', '{not-json');
    renderLoginPassword();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
    expect(sessionStorage.getItem('akis_login_data')).toBeNull();
  });

  it('clears + redirects when sessionStorage data is missing fields', () => {
    sessionStorage.setItem('akis_login_data', JSON.stringify({ userId: 'u1' }));
    renderLoginPassword();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});

describe('LoginPassword — rendering with valid session', () => {
  beforeEach(() => {
    sessionStorage.setItem('akis_login_data', VALID_STORAGE);
  });

  it('renders the password label + heading', () => {
    renderLoginPassword();
    expect(screen.getByText('Şifrenizi girin')).toBeInTheDocument();
    expect(screen.getByText('Şifre')).toBeInTheDocument();
  });

  it('renders the email from sessionStorage', () => {
    renderLoginPassword();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
  });

  it('renders the back button labelled "Geri"', () => {
    renderLoginPassword();
    expect(screen.getByText('Geri')).toBeInTheDocument();
  });

  it('renders the forgot-password link', () => {
    renderLoginPassword();
    const link = screen.getByText('Şifremi unuttum');
    expect(link).toHaveAttribute('href', '/forgot-password');
  });

  it('toggles password visibility when GÖSTER / GİZLE clicked', () => {
    renderLoginPassword();
    const pwInput = document.getElementById('password') as HTMLInputElement;
    expect(pwInput.type).toBe('password');
    fireEvent.click(screen.getByText('GÖSTER'));
    expect(pwInput.type).toBe('text');
    fireEvent.click(screen.getByText('GİZLE'));
    expect(pwInput.type).toBe('password');
  });

  it('back button navigates to /login', () => {
    renderLoginPassword();
    fireEvent.click(screen.getByText('Geri'));
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});

describe('LoginPassword — form submission', () => {
  beforeEach(() => {
    sessionStorage.setItem('akis_login_data', VALID_STORAGE);
  });

  it('calls loginComplete with userId+password, calls setUser, navigates to POST_AUTH_PATH', async () => {
    mockGetReturnTo.mockReturnValue(null);
    mockLoginComplete.mockResolvedValueOnce({
      user: { id: 'u1', name: 'Test', email: 'user@example.com' },
    });
    renderLoginPassword();

    const pwInput = document.getElementById('password') as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: 'secret123' } });
    fireEvent.submit(pwInput.closest('form')!);

    await vi.waitFor(() => {
      expect(mockLoginComplete).toHaveBeenCalledWith({
        userId: 'u1',
        password: 'secret123',
      });
    });
    await vi.waitFor(() => {
      expect(mockSetUser).toHaveBeenCalledWith({
        id: 'u1',
        name: 'Test',
        email: 'user@example.com',
      });
    });
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/chat', { replace: true });
    });
    expect(mockClearReturnTo).toHaveBeenCalled();
    expect(sessionStorage.getItem('akis_login_data')).toBeNull();
  });

  it('navigates to returnTo path when getReturnTo() returns a value', async () => {
    mockGetReturnTo.mockReturnValue('/chat/abc123');
    mockLoginComplete.mockResolvedValueOnce({
      user: { id: 'u1', name: 'Test', email: 'user@example.com' },
    });
    renderLoginPassword();

    const pwInput = document.getElementById('password') as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: 'secret123' } });
    fireEvent.submit(pwInput.closest('form')!);

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/chat/abc123', { replace: true });
    });
  });

  it('renders plain-text error message when AuthAPI throws', async () => {
    mockLoginComplete.mockRejectedValueOnce(new Error('Wrong password'));
    renderLoginPassword();

    const pwInput = document.getElementById('password') as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: 'badpass1' } });
    fireEvent.submit(pwInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Wrong password')).toBeInTheDocument();
    });
    // setUser should not have been called on error
    expect(mockSetUser).not.toHaveBeenCalled();
  });

  it('parses JSON error.message when AuthAPI throws structured JSON', async () => {
    mockLoginComplete.mockRejectedValueOnce(
      new Error(JSON.stringify({ message: 'Bilgileriniz hatalı' })),
    );
    renderLoginPassword();

    const pwInput = document.getElementById('password') as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: 'badpass1' } });
    fireEvent.submit(pwInput.closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Bilgileriniz hatalı')).toBeInTheDocument();
    });
  });

  it('falls back to default Turkish message when error is not an Error instance', async () => {
    mockLoginComplete.mockRejectedValueOnce('weird');
    renderLoginPassword();
    const pwInput = document.getElementById('password') as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: 'badpass1' } });
    fireEvent.submit(pwInput.closest('form')!);

    await vi.waitFor(() => {
      expect(
        screen.getByText('Yanlış şifre. Lütfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });
});
