/**
 * ForgotPassword — Auth forgot-password page tests
 *
 * Covers:
 *  - Smoke render (heading, email input, submit, back link)
 *  - Form submit happy path → fetch called, success card shown
 *  - Network failure → "Sunucuya ulasilamadi." error rendered
 *  - Server-side error (ok=false) → error message rendered
 *  - "Kodu Gir" button on success → navigate('/reset-password', { state: ... })
 *  - Empty email submit is short-circuited
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/mock-logo.svg',
}));

import ForgotPassword from '../ForgotPassword';

function renderForgot() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ForgotPassword — rendering', () => {
  it('renders the heading + description', () => {
    renderForgot();
    expect(screen.getByText('Sifremi Unuttum')).toBeInTheDocument();
    expect(screen.getByText(/Kayitli e-posta adresinizi girin/)).toBeInTheDocument();
  });

  it('renders the email input field', () => {
    renderForgot();
    const inputs = screen.getAllByPlaceholderText('ornek@email.com');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(inputs[0]).toHaveAttribute('type', 'email');
  });

  it('renders the submit button labelled "Sifirlama Kodu Gonder"', () => {
    renderForgot();
    expect(screen.getByText('Sifirlama Kodu Gonder')).toBeInTheDocument();
  });

  it('renders the back-to-login link', () => {
    renderForgot();
    const link = screen.getByText(/Giris sayfasina don/);
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders the AKIS logo', () => {
    renderForgot();
    const logo = screen.getByAltText('AKIS');
    expect(logo).toHaveAttribute('src', '/mock-logo.svg');
  });
});

describe('ForgotPassword — submission', () => {
  it('does not call fetch when email is empty', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForgot();
    fireEvent.click(screen.getByText('Sifirlama Kodu Gonder'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path: posts the email and shows the success card', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, userId: 'u1' }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForgot();
    const input = screen.getByPlaceholderText('ornek@email.com');
    fireEvent.change(input, { target: { value: 'user@example.com' } });
    fireEvent.submit(input.closest('form')!);

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/auth/forgot-password',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        }),
      );
    });
    await vi.waitFor(() => {
      expect(screen.getByText('Kod Gonderildi')).toBeInTheDocument();
    });
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
  });

  it('renders server error message when ok=false', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: { message: 'Limit aşıldı' } }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForgot();
    const input = screen.getByPlaceholderText('ornek@email.com');
    fireEvent.change(input, { target: { value: 'a@b.com' } });
    fireEvent.submit(input.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Limit aşıldı')).toBeInTheDocument();
    });
  });

  it('falls back to generic error when no error.message is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForgot();
    const input = screen.getByPlaceholderText('ornek@email.com');
    fireEvent.change(input, { target: { value: 'a@b.com' } });
    fireEvent.submit(input.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Bir hata olustu.')).toBeInTheDocument();
    });
  });

  it('renders connection error when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network')) as unknown as typeof fetch;
    renderForgot();
    const input = screen.getByPlaceholderText('ornek@email.com');
    fireEvent.change(input, { target: { value: 'a@b.com' } });
    fireEvent.submit(input.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Sunucuya ulasilamadi.')).toBeInTheDocument();
    });
  });
});

describe('ForgotPassword — success-state actions', () => {
  it('"Kodu Gir" button navigates to /reset-password with state', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, userId: 'u1' }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForgot();
    const input = screen.getByPlaceholderText('ornek@email.com');
    fireEvent.change(input, { target: { value: 'user@example.com' } });
    fireEvent.submit(input.closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Kod Gonderildi')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Kodu Gir'));
    expect(mockNavigate).toHaveBeenCalledWith('/reset-password', {
      state: { email: 'user@example.com', userId: 'u1' },
    });
  });
});
