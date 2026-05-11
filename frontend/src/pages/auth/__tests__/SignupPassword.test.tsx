/**
 * SignupPassword — Auth signup (step 2) tests
 *
 * Covers:
 *  - Renders null when sessionStorage is empty
 *  - Renders password + confirm-password inputs + back button
 *  - Validation: mismatch, < 8 chars, missing uppercase, missing digit
 *  - Submit happy path (default flow → /signup/verify-email)
 *  - Submit verificationBypassed → setUser + navigate to POST_AUTH_PATH
 *  - Show/hide toggles for both password and confirm fields
 *  - Plain-text + JSON error paths
 *  - Back button navigates to /signup
 *  - Submit when sessionStorage was cleared midway (re-check error path)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockSetUser = vi.fn();
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, setUser: mockSetUser }),
}));

const mockSignupPassword = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    signupPassword: (data: { userId: string; password: string }) =>
      mockSignupPassword(data),
  },
}));

import SignupPassword from '../SignupPassword';

function renderSignupPassword() {
  return render(
    <MemoryRouter initialEntries={['/signup/password']}>
      <Routes>
        <Route path="/signup/password" element={<SignupPassword />} />
      </Routes>
    </MemoryRouter>,
  );
}

const VALID_STORAGE = JSON.stringify({
  userId: 'u1',
  firstName: 'Ali',
  lastName: 'Yılmaz',
  email: 'a@b.com',
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('SignupPassword — guard rails', () => {
  it('navigates to /signup when sessionStorage has no signup data', () => {
    renderSignupPassword();
    expect(mockNavigate).toHaveBeenCalledWith('/signup');
  });
});

describe('SignupPassword — rendering with valid storage', () => {
  beforeEach(() => {
    sessionStorage.setItem('akis_signup_data', VALID_STORAGE);
  });

  it('renders password and confirm-password inputs', () => {
    renderSignupPassword();
    expect(document.getElementById('password')).toBeInTheDocument();
    expect(document.getElementById('confirmPassword')).toBeInTheDocument();
  });

  it('renders the email from sessionStorage', () => {
    renderSignupPassword();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
  });

  it('renders the heading + back button', () => {
    renderSignupPassword();
    expect(screen.getByText('Şifre oluşturun')).toBeInTheDocument();
    expect(screen.getByText('Geri')).toBeInTheDocument();
  });

  it('toggles the password visibility (both fields independently)', () => {
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    expect(pw.type).toBe('password');
    expect(cpw.type).toBe('password');
    const toggleButtons = screen.getAllByText('GÖSTER');
    // First toggle = password
    fireEvent.click(toggleButtons[0]);
    expect(pw.type).toBe('text');
    expect(cpw.type).toBe('password');
    // Toggle back
    fireEvent.click(screen.getByText('GİZLE'));
    expect(pw.type).toBe('password');
    // Now click the (still-GÖSTER) confirm toggle
    const refreshedToggles = screen.getAllByText('GÖSTER');
    fireEvent.click(refreshedToggles[1]);
    expect(cpw.type).toBe('text');
  });

  it('back button navigates to /signup', () => {
    renderSignupPassword();
    fireEvent.click(screen.getByText('Geri'));
    expect(mockNavigate).toHaveBeenCalledWith('/signup');
  });
});

describe('SignupPassword — validation', () => {
  beforeEach(() => {
    sessionStorage.setItem('akis_signup_data', VALID_STORAGE);
  });

  function fillAndSubmit(password: string, confirm: string) {
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: password } });
    fireEvent.change(cpw, { target: { value: confirm } });
    fireEvent.submit(pw.closest('form')!);
  }

  it('shows mismatch error when passwords differ', () => {
    renderSignupPassword();
    fillAndSubmit('Password1', 'Password2');
    expect(screen.getByText('Şifreler eşleşmiyor')).toBeInTheDocument();
    expect(mockSignupPassword).not.toHaveBeenCalled();
  });

  it('shows length error when password is < 8 chars', () => {
    renderSignupPassword();
    fillAndSubmit('Ab1', 'Ab1');
    expect(screen.getByText('Şifre en az 8 karakter olmalıdır')).toBeInTheDocument();
  });

  it('shows uppercase requirement error', () => {
    renderSignupPassword();
    fillAndSubmit('password123', 'password123');
    expect(
      screen.getByText('Şifre en az 1 büyük harf içermelidir'),
    ).toBeInTheDocument();
  });

  it('shows digit requirement error', () => {
    renderSignupPassword();
    fillAndSubmit('Password', 'Password');
    expect(
      screen.getByText('Şifre en az 1 rakam içermelidir'),
    ).toBeInTheDocument();
  });
});

describe('SignupPassword — submission', () => {
  beforeEach(() => {
    sessionStorage.setItem('akis_signup_data', VALID_STORAGE);
  });

  it('default flow: signupPassword resolves, navigates to /signup/verify-email', async () => {
    mockSignupPassword.mockResolvedValueOnce({
      ok: true,
      message: 'verify',
      verificationBypassed: false,
    });
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);

    await vi.waitFor(() => {
      expect(mockSignupPassword).toHaveBeenCalledWith({
        userId: 'u1',
        password: 'Password1',
      });
    });
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/signup/verify-email');
    });
  });

  it('verificationBypassed=true → setUser + navigate to /chat', async () => {
    mockSignupPassword.mockResolvedValueOnce({
      ok: true,
      message: 'ok',
      verificationBypassed: true,
      user: { id: 'u1', name: 'Ali', email: 'a@b.com' },
    });
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);

    await vi.waitFor(() => {
      expect(mockSetUser).toHaveBeenCalledWith({
        id: 'u1',
        name: 'Ali',
        email: 'a@b.com',
      });
    });
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/chat', { replace: true });
    });
    expect(sessionStorage.getItem('akis_signup_data')).toBeNull();
  });

  it('renders plain-text error message when API throws', async () => {
    mockSignupPassword.mockRejectedValueOnce(new Error('Failed'));
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  it('parses JSON error.error field and renders it', async () => {
    mockSignupPassword.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: 'Şifre zayıf' })),
    );
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Şifre zayıf')).toBeInTheDocument();
    });
  });

  it('falls back to default error when err is not an Error', async () => {
    mockSignupPassword.mockRejectedValueOnce('weird');
    renderSignupPassword();
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);
    await vi.waitFor(() => {
      expect(
        screen.getByText('Şifre belirlenemedi. Lütfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });

  it('handles sessionStorage being cleared between mount and submit', async () => {
    renderSignupPassword();
    sessionStorage.removeItem('akis_signup_data');
    const pw = document.getElementById('password') as HTMLInputElement;
    const cpw = document.getElementById('confirmPassword') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Password1' } });
    fireEvent.change(cpw, { target: { value: 'Password1' } });
    fireEvent.submit(pw.closest('form')!);
    await vi.waitFor(() => {
      expect(
        screen.getByText('Kayıt oturumu sona erdi. Lütfen tekrar başlatın.'),
      ).toBeInTheDocument();
    });
  });
});
