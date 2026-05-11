/**
 * InviteAccept — Auth invite-accept page tests
 *
 * Covers four UI branches:
 *   1. Loading state while validating
 *   2. Invalid invite branch (no token, API rejects, valid=false)
 *   3. Existing-user branch (existingUser=true → Log In CTA)
 *   4. Accept-invite form: render, validation, happy + error submission
 *
 * Also exercises both TR and EN locale variants where applicable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockValidateInvite = vi.fn();
const mockAcceptInvite = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    validateInvite: (token: string) => mockValidateInvite(token),
    acceptInvite: (d: { token: string; firstName: string; lastName: string; password: string }) =>
      mockAcceptInvite(d),
  },
}));

let mockLocale: 'tr' | 'en' = 'tr';
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    locale: mockLocale,
    t: (key: string) => key,
    availableLocales: ['tr', 'en'],
    status: 'ready' as const,
    setLocale: vi.fn(),
  }),
}));

import InviteAccept from '../InviteAccept';

function renderInvite(token: string | null = 'tok-1') {
  return render(
    <MemoryRouter initialEntries={[token === null ? '/invite/' : `/invite/${token}`]}>
      <Routes>
        <Route path="/invite/:token" element={<InviteAccept />} />
        <Route path="/invite" element={<InviteAccept />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLocale = 'tr';
});

describe('InviteAccept — token missing', () => {
  it('renders invalid-invite UI when there is no token in the URL', async () => {
    renderInvite(null);
    expect(
      await screen.findByText('Davet bağlantısı eksik.'),
    ).toBeInTheDocument();
  });

  it('renders the English variant when locale=en', async () => {
    mockLocale = 'en';
    renderInvite(null);
    expect(
      await screen.findByText('Invite link is missing.'),
    ).toBeInTheDocument();
  });
});

describe('InviteAccept — validation calls', () => {
  it('shows loading state while validation pending', () => {
    // Return a promise we never resolve
    mockValidateInvite.mockReturnValueOnce(new Promise(() => undefined));
    renderInvite('tok-1');
    expect(screen.getByText('Davet doğrulanıyor...')).toBeInTheDocument();
  });

  it('shows invalid-invite when API returns valid=false', async () => {
    mockValidateInvite.mockResolvedValueOnce({ valid: false });
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(
        screen.getByText('Bu davet bağlantısı geçersiz veya süresi dolmuş.'),
      ).toBeInTheDocument();
    });
  });

  it('shows generic error when validation throws', async () => {
    mockValidateInvite.mockRejectedValueOnce(new Error('boom'));
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(
        screen.getByText('Davet doğrulanamadı. Lütfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });

  it('renders English error variant', async () => {
    mockLocale = 'en';
    mockValidateInvite.mockResolvedValueOnce({ valid: false });
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(
        screen.getByText('This invite link is invalid or expired.'),
      ).toBeInTheDocument();
    });
  });

  it('renders English-generic on throw', async () => {
    mockLocale = 'en';
    mockValidateInvite.mockRejectedValueOnce(new Error('boom'));
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(
        screen.getByText('Could not validate invite. Please try again.'),
      ).toBeInTheDocument();
    });
  });
});

describe('InviteAccept — existing-user branch', () => {
  it('renders "you already have an account" with Log In CTA when existingUser=true', async () => {
    mockValidateInvite.mockResolvedValueOnce({
      valid: true,
      email: 'a@b.com',
      inviterName: 'Admin',
      existingUser: true,
    });
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(screen.getByText('Zaten Hesabınız Var')).toBeInTheDocument();
    });
    expect(screen.getByText('Giriş Yap')).toBeInTheDocument();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
  });

  it('renders English variant for existing-user branch', async () => {
    mockLocale = 'en';
    mockValidateInvite.mockResolvedValueOnce({
      valid: true,
      email: 'a@b.com',
      inviterName: 'Boss',
      existingUser: true,
    });
    renderInvite('tok-1');
    await vi.waitFor(() => {
      expect(
        screen.getByText('You Already Have an Account'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Log In')).toBeInTheDocument();
  });
});

describe('InviteAccept — accept form', () => {
  beforeEach(() => {
    mockValidateInvite.mockResolvedValue({
      valid: true,
      email: 'a@b.com',
      inviterName: 'Admin',
      expiresAt: '2099-01-01',
      existingUser: false,
    });
  });

  async function renderAndWaitForForm() {
    renderInvite('tok-1');
    const heading = mockLocale === 'tr' ? 'Daveti Kabul Et' : 'Accept Invite';
    await vi.waitFor(() => {
      expect(screen.getByText(heading)).toBeInTheDocument();
    });
  }

  it('renders the form fields (firstName/lastName/password/confirmPassword)', async () => {
    await renderAndWaitForForm();
    expect(document.getElementById('firstName')).toBeInTheDocument();
    expect(document.getElementById('lastName')).toBeInTheDocument();
    expect(document.getElementById('password')).toBeInTheDocument();
    expect(document.getElementById('confirmPassword')).toBeInTheDocument();
  });

  it('shows mismatch error when passwords differ', async () => {
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'Ali' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'Password1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, {
      target: { value: 'Different1' },
    });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    expect(screen.getByText('Şifreler eşleşmiyor.')).toBeInTheDocument();
    expect(mockAcceptInvite).not.toHaveBeenCalled();
  });

  it('shows length error when password is < 8 chars', async () => {
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'Ali' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'Ab1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, { target: { value: 'Ab1' } });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    expect(
      screen.getByText('Şifre en az 8 karakter olmalıdır.'),
    ).toBeInTheDocument();
  });

  it('happy path: calls acceptInvite + navigates to /chat', async () => {
    mockAcceptInvite.mockResolvedValueOnce({
      user: { id: 'u1', name: 'Ali Y', email: 'a@b.com' },
      message: 'ok',
    });
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'Ali' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'Password1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, {
      target: { value: 'Password1' },
    });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);

    await vi.waitFor(() => {
      expect(mockAcceptInvite).toHaveBeenCalledWith({
        token: 'tok-1',
        firstName: 'Ali',
        lastName: 'Y',
        password: 'Password1',
      });
    });
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/chat');
    });
  });

  it('renders API error message on failure', async () => {
    mockAcceptInvite.mockRejectedValueOnce(new Error('Daveti kabul edemedik'));
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'Ali' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'Password1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, {
      target: { value: 'Password1' },
    });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Daveti kabul edemedik')).toBeInTheDocument();
    });
  });

  it('falls back to "Unknown error" when rejection is not Error', async () => {
    mockAcceptInvite.mockRejectedValueOnce('weird');
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'Ali' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'Password1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, {
      target: { value: 'Password1' },
    });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Unknown error')).toBeInTheDocument();
    });
  });

  it('English locale: mismatch + length error render in English', async () => {
    mockLocale = 'en';
    await renderAndWaitForForm();
    fireEvent.change(document.getElementById('firstName')!, { target: { value: 'A' } });
    fireEvent.change(document.getElementById('lastName')!, { target: { value: 'Y' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'short1' } });
    fireEvent.change(document.getElementById('confirmPassword')!, { target: { value: 'short2' } });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();

    fireEvent.change(document.getElementById('confirmPassword')!, { target: { value: 'short1' } });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    expect(
      screen.getByText('Password must be at least 8 characters.'),
    ).toBeInTheDocument();
  });

  it('renders the "Sign-in" link in TR', async () => {
    await renderAndWaitForForm();
    const link = screen.getByText('Giriş yap');
    expect(link).toHaveAttribute('href', '/login');
  });
});
