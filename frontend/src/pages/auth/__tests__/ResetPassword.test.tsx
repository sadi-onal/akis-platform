/**
 * ResetPassword — Auth reset-password page tests
 *
 * Covers:
 *  - Renders email input if no email in location.state
 *  - Hides email input + uses passed email from location.state
 *  - Code input only accepts digits (truncated to 6)
 *  - Submit disabled when isValid is false (empty/short/mismatched)
 *  - Submit happy path → HttpClient.post + success card + "Giris Yap" navigates
 *  - Server-side ok=false → error rendered
 *  - HttpClient throws → "Sunucuya ulasilamadi." rendered
 *  - Password mismatch inline warning
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockNavigate = vi.fn();
let mockLocationState: unknown = null;
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/reset-password', state: mockLocationState }),
  };
});

vi.mock('../../../theme/brand', () => ({
  LOGO_MARK_SVG: '/mock-logo.svg',
}));

// Mock HttpClient — it is dynamic-imported by ResetPassword
const mockPost = vi.fn();
vi.mock('../../../services/api/HttpClient', () => ({
  HttpClient: class {
    post = mockPost;
  },
}));

vi.mock('../../../services/api/config', () => ({
  getApiBaseUrl: () => 'http://test.local',
}));

import ResetPassword from '../ResetPassword';

function renderReset() {
  return render(
    <MemoryRouter initialEntries={['/reset-password']}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLocationState = null;
});

describe('ResetPassword — rendering', () => {
  it('renders the heading and description', () => {
    renderReset();
    expect(screen.getByText('Sifre Sifirlama')).toBeInTheDocument();
    expect(screen.getByText(/E-postaniza gelen 6 haneli kodu/)).toBeInTheDocument();
  });

  it('shows the email input when no email was passed in location.state', () => {
    renderReset();
    expect(screen.getByPlaceholderText('ornek@email.com')).toBeInTheDocument();
  });

  it('hides the email input when email is passed via location.state', () => {
    mockLocationState = { email: 'pre@example.com' };
    renderReset();
    expect(screen.queryByPlaceholderText('ornek@email.com')).toBeNull();
  });

  it('renders submit button (disabled when form is invalid)', () => {
    renderReset();
    const btn = screen.getByText('Sifreyi Guncelle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders the back-to-login link', () => {
    renderReset();
    expect(screen.getByText(/Giris sayfasina don/)).toBeInTheDocument();
  });
});

describe('ResetPassword — code input', () => {
  it('strips non-digit characters and limits to 6 chars', () => {
    renderReset();
    const codeInput = screen.getByPlaceholderText('000000') as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '12abc3456789' } });
    expect(codeInput.value).toBe('123456');
  });
});

describe('ResetPassword — validation', () => {
  it('shows inline mismatch warning when confirmPassword differs', () => {
    renderReset();
    const pwInputs = screen.getAllByPlaceholderText(/karakter|tekrar/i);
    // First: new password placeholder
    // Second: confirm placeholder
    const newPw = pwInputs[0];
    const confirm = pwInputs[1];
    fireEvent.change(newPw, { target: { value: 'Password1' } });
    fireEvent.change(confirm, { target: { value: 'Different1' } });
    expect(screen.getByText('Sifreler eslesmiyor')).toBeInTheDocument();
  });
});

describe('ResetPassword — submission', () => {
  function fillForm(opts: { code?: string; pw?: string; confirm?: string } = {}) {
    const codeInput = screen.getByPlaceholderText('000000');
    const pwInputs = screen.getAllByPlaceholderText(/karakter|tekrar/i);
    fireEvent.change(codeInput, { target: { value: opts.code ?? '123456' } });
    fireEvent.change(pwInputs[0], { target: { value: opts.pw ?? 'Password1' } });
    fireEvent.change(pwInputs[1], { target: { value: opts.confirm ?? 'Password1' } });
  }

  it('happy path: calls HttpClient.post + shows success card + "Giris Yap" navigates to /login', async () => {
    mockLocationState = { email: 'a@b.com' };
    mockPost.mockResolvedValueOnce({ ok: true });
    renderReset();
    fillForm();
    fireEvent.click(screen.getByText('Sifreyi Guncelle'));
    await vi.waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/auth/reset-password', {
        email: 'a@b.com',
        code: '123456',
        newPassword: 'Password1',
      });
    });
    await vi.waitFor(() => {
      expect(screen.getByText('Sifre Guncellendi')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Giris Yap'));
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('shows server error message when ok=false', async () => {
    mockLocationState = { email: 'a@b.com' };
    mockPost.mockResolvedValueOnce({ ok: false, error: { message: 'Kod hatalı' } });
    renderReset();
    fillForm();
    fireEvent.click(screen.getByText('Sifreyi Guncelle'));
    await vi.waitFor(() => {
      expect(screen.getByText('Kod hatalı')).toBeInTheDocument();
    });
  });

  it('falls back to generic error when ok=false with no error.message', async () => {
    mockLocationState = { email: 'a@b.com' };
    mockPost.mockResolvedValueOnce({ ok: false });
    renderReset();
    fillForm();
    fireEvent.click(screen.getByText('Sifreyi Guncelle'));
    await vi.waitFor(() => {
      expect(screen.getByText('Gecersiz veya suresi dolmus kod.')).toBeInTheDocument();
    });
  });

  it('renders connection error when HttpClient throws', async () => {
    mockLocationState = { email: 'a@b.com' };
    mockPost.mockRejectedValueOnce(new Error('network'));
    renderReset();
    fillForm();
    fireEvent.click(screen.getByText('Sifreyi Guncelle'));
    await vi.waitFor(() => {
      expect(screen.getByText('Sunucuya ulasilamadi.')).toBeInTheDocument();
    });
  });

  it('does nothing when isValid is false (button disabled, no API call)', () => {
    renderReset();
    fireEvent.click(screen.getByText('Sifreyi Guncelle'));
    expect(mockPost).not.toHaveBeenCalled();
  });
});
