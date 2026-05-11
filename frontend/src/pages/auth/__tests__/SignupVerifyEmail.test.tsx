/**
 * SignupVerifyEmail — Auth signup (step 3) tests
 *
 * Covers:
 *  - Renders null when sessionStorage has no signup data
 *  - Renders 6 code input slots, email from storage, resend button
 *  - Verify happy path → setUser + navigate('/chat') + cleans storage
 *  - Validation: < 6 digits shows "Lütfen 6 haneli kodun tamamını girin"
 *  - Wrong code → error rendered, inputs cleared
 *  - Resend success / failure paths
 *  - Code change: digit-only, auto-advance, backspace focus prev
 *  - Paste handler fills code from clipboard
 *  - JSON / non-Error error paths
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

const mockVerifyEmail = vi.fn();
const mockResendCode = vi.fn();
vi.mock('../../../services/api/auth', () => ({
  AuthAPI: {
    verifyEmail: (d: { userId: string; code: string }) => mockVerifyEmail(d),
    resendCode: (d: { userId: string }) => mockResendCode(d),
  },
}));

import SignupVerifyEmail from '../SignupVerifyEmail';

function renderVerify() {
  return render(
    <MemoryRouter initialEntries={['/signup/verify-email']}>
      <Routes>
        <Route path="/signup/verify-email" element={<SignupVerifyEmail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const VALID_STORAGE = JSON.stringify({
  userId: 'u1',
  email: 'a@b.com',
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // Use a window.alert spy so the resendCode handler's alert() doesn't break jsdom
  window.alert = vi.fn();
});

describe('SignupVerifyEmail — guard rail', () => {
  it('redirects to /signup when storage is empty', () => {
    renderVerify();
    expect(mockNavigate).toHaveBeenCalledWith('/signup');
  });
});

describe('SignupVerifyEmail — rendering with storage', () => {
  beforeEach(() => sessionStorage.setItem('akis_signup_data', VALID_STORAGE));

  it('renders heading + email + 6 input slots', () => {
    renderVerify();
    expect(screen.getByText('E-postanızı doğrulayın')).toBeInTheDocument();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
    const inputs = screen
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).maxLength === 1);
    expect(inputs).toHaveLength(6);
  });

  it('renders the resend code link', () => {
    renderVerify();
    expect(
      screen.getByText('Kod gelmedi mi? Tekrar gönder'),
    ).toBeInTheDocument();
  });

  it('renders the "Doğrula" submit button', () => {
    renderVerify();
    expect(screen.getByRole('button', { name: 'Doğrula' })).toBeInTheDocument();
  });
});

describe('SignupVerifyEmail — code input behavior', () => {
  beforeEach(() => sessionStorage.setItem('akis_signup_data', VALID_STORAGE));

  function getDigitInputs(): HTMLInputElement[] {
    return screen
      .getAllByRole('textbox')
      .filter((el): el is HTMLInputElement => (el as HTMLInputElement).maxLength === 1);
  }

  it('rejects non-digit input', () => {
    renderVerify();
    const inputs = getDigitInputs();
    fireEvent.change(inputs[0], { target: { value: 'a' } });
    expect(inputs[0].value).toBe('');
  });

  it('accepts a single digit and stores only the last character of multi-char input', () => {
    renderVerify();
    const inputs = getDigitInputs();
    fireEvent.change(inputs[0], { target: { value: '12' } });
    expect(inputs[0].value).toBe('2');
  });

  it('handles backspace from empty slot by focusing previous slot', () => {
    renderVerify();
    const inputs = getDigitInputs();
    // Type into slot 0
    fireEvent.change(inputs[0], { target: { value: '1' } });
    // Focus slot 1 (now empty) and backspace
    inputs[1].focus();
    fireEvent.keyDown(inputs[1], { key: 'Backspace' });
    expect(document.activeElement).toBe(inputs[0]);
  });

  it('paste fills multiple slots and focuses the last filled', () => {
    renderVerify();
    const inputs = getDigitInputs();
    fireEvent.paste(inputs[0], {
      clipboardData: {
        getData: () => '123abc456',
      },
    });
    expect(inputs[0].value).toBe('1');
    expect(inputs[1].value).toBe('2');
    expect(inputs[2].value).toBe('3');
    expect(inputs[3].value).toBe('4');
    expect(inputs[4].value).toBe('5');
    expect(inputs[5].value).toBe('6');
  });
});

describe('SignupVerifyEmail — submission', () => {
  beforeEach(() => sessionStorage.setItem('akis_signup_data', VALID_STORAGE));

  function getDigitInputs(): HTMLInputElement[] {
    return screen
      .getAllByRole('textbox')
      .filter((el): el is HTMLInputElement => (el as HTMLInputElement).maxLength === 1);
  }

  function fillCode(code: string) {
    const inputs = getDigitInputs();
    for (let i = 0; i < code.length; i++) {
      fireEvent.change(inputs[i], { target: { value: code[i] } });
    }
  }

  it('happy path: calls verifyEmail, sets user, clears storage, navigates to /chat', async () => {
    mockVerifyEmail.mockResolvedValueOnce({
      user: { id: 'u1', name: 'Ali', email: 'a@b.com' },
      message: 'ok',
    });
    renderVerify();
    fillCode('123456');
    const form = getDigitInputs()[0].closest('form')!;
    fireEvent.submit(form);

    await vi.waitFor(() => {
      expect(mockVerifyEmail).toHaveBeenCalledWith({
        userId: 'u1',
        code: '123456',
      });
    });
    await vi.waitFor(() => {
      expect(mockSetUser).toHaveBeenCalledWith({
        id: 'u1',
        name: 'Ali',
        email: 'a@b.com',
      });
    });
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/chat');
    });
    expect(sessionStorage.getItem('akis_signup_data')).toBeNull();
  });

  it('shows a "6 haneli kod" warning when fewer than 6 digits entered', () => {
    renderVerify();
    fillCode('123');
    fireEvent.submit(getDigitInputs()[0].closest('form')!);
    expect(
      screen.getByText('Lütfen 6 haneli kodun tamamını girin'),
    ).toBeInTheDocument();
    expect(mockVerifyEmail).not.toHaveBeenCalled();
  });

  it('renders API plain-text error and clears the code on failure', async () => {
    mockVerifyEmail.mockRejectedValueOnce(new Error('Kod yanlış'));
    renderVerify();
    fillCode('123456');
    fireEvent.submit(getDigitInputs()[0].closest('form')!);

    await vi.waitFor(() => {
      expect(screen.getByText('Kod yanlış')).toBeInTheDocument();
    });
    // After failure, code inputs should be cleared
    for (const inp of getDigitInputs()) {
      expect(inp.value).toBe('');
    }
  });

  it('parses JSON error.error field', async () => {
    mockVerifyEmail.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: 'Süresi doldu' })),
    );
    renderVerify();
    fillCode('123456');
    fireEvent.submit(getDigitInputs()[0].closest('form')!);
    await vi.waitFor(() => {
      expect(screen.getByText('Süresi doldu')).toBeInTheDocument();
    });
  });

  it('falls back to default error message when err is non-Error', async () => {
    mockVerifyEmail.mockRejectedValueOnce('weird');
    renderVerify();
    fillCode('123456');
    fireEvent.submit(getDigitInputs()[0].closest('form')!);
    await vi.waitFor(() => {
      expect(
        screen.getByText('Kod yanlış veya süresi dolmuş. Lütfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });
});

describe('SignupVerifyEmail — resend code', () => {
  beforeEach(() => sessionStorage.setItem('akis_signup_data', VALID_STORAGE));

  it('resends and shows browser alert on success', async () => {
    mockResendCode.mockResolvedValueOnce({ ok: true, message: 'ok' });
    renderVerify();
    fireEvent.click(screen.getByText('Kod gelmedi mi? Tekrar gönder'));
    await vi.waitFor(() => {
      expect(mockResendCode).toHaveBeenCalledWith({ userId: 'u1' });
    });
    await vi.waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith(
        'Doğrulama kodu e-postanıza tekrar gönderildi',
      );
    });
  });

  it('shows plain-text error on resend failure', async () => {
    mockResendCode.mockRejectedValueOnce(new Error('Lütfen bekleyin'));
    renderVerify();
    fireEvent.click(screen.getByText('Kod gelmedi mi? Tekrar gönder'));
    await vi.waitFor(() => {
      expect(screen.getByText('Lütfen bekleyin')).toBeInTheDocument();
    });
  });

  it('parses JSON error.message on resend failure', async () => {
    mockResendCode.mockRejectedValueOnce(
      new Error(JSON.stringify({ message: 'Çok fazla deneme' })),
    );
    renderVerify();
    fireEvent.click(screen.getByText('Kod gelmedi mi? Tekrar gönder'));
    await vi.waitFor(() => {
      expect(screen.getByText('Çok fazla deneme')).toBeInTheDocument();
    });
  });

  it('falls back to default message when non-Error rejection', async () => {
    mockResendCode.mockRejectedValueOnce('boom');
    renderVerify();
    fireEvent.click(screen.getByText('Kod gelmedi mi? Tekrar gönder'));
    await vi.waitFor(() => {
      expect(
        screen.getByText('Kod tekrar gönderilemedi. Lütfen tekrar deneyin.'),
      ).toBeInTheDocument();
    });
  });
});
