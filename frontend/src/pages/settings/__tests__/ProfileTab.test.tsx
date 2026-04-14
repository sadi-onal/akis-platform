/**
 * ProfileTab — Settings profile editing tests
 *
 * Covers:
 *  - Profile form rendering (name field, email read-only, member since)
 *  - Save button triggers PUT /api/settings/profile
 *  - Password change form validates min 8 chars
 *  - Password mismatch shows inline error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------- Mocks ----------

const mockSetUser = vi.fn();

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Omer Yasir', email: 'omer@example.com' },
    setUser: mockSetUser,
    loading: false,
  }),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

vi.mock('../../../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('tab=profile'), vi.fn()],
  useNavigate: () => vi.fn(),
}));

// ---------- Helpers ----------

const PROFILE_RESPONSE = {
  id: 'u1',
  name: 'Omer Yasir',
  email: 'omer@example.com',
  emailVerified: true,
  status: 'active',
  createdAt: '2026-01-15T10:00:00.000Z',
};

function mockFetchProfile() {
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (url === '/api/settings/profile' && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(PROFILE_RESPONSE),
      });
    }
    if (url === '/api/settings/profile' && opts?.method === 'PUT') {
      const body = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...PROFILE_RESPONSE, name: body.name }),
      });
    }
    if (url === '/api/settings/profile/password' && opts?.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    }
    // Default for other fetch calls (ai-keys status, integrity, etc.)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

// ---------- Tests ----------

import SettingsPage from '../SettingsPage';

describe('ProfileTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetchProfile() as unknown as typeof fetch;
  });

  it('renders profile form with name input populated', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('Omer Yasir');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });

  it('shows email as read-only text', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('omer@example.com')).toBeInTheDocument();
    });
  });

  it('shows member since date label', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.memberSince')).toBeInTheDocument();
    });
  });

  it('shows account info section with status', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.accountInfo')).toBeInTheDocument();
    });
  });

  it('save button calls PUT /api/settings/profile', async () => {
    const fetchSpy = mockFetchProfile();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<SettingsPage />);

    // Wait for profile to load
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('Omer Yasir').length).toBeGreaterThan(0);
    });

    // Change name input
    const nameInput = screen.getAllByDisplayValue('Omer Yasir')[0];
    fireEvent.change(nameInput, { target: { value: 'Omer Updated' } });

    // Click save button
    const saveButtons = screen.getAllByText('settings.ai.save');
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (c: [string, RequestInit?]) => c[0] === '/api/settings/profile' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.name).toBe('Omer Updated');
    });
  });

  it('shows password min length warning when typing short password', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordTitle')).toBeInTheDocument();
    });

    // Find new password input by label
    const newPwLabel = screen.getByText('settings.profile.newPassword');
    const newPwInput = newPwLabel.parentElement?.querySelector('input');
    expect(newPwInput).toBeTruthy();

    fireEvent.change(newPwInput!, { target: { value: 'abc' } });

    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordMinLength')).toBeInTheDocument();
    });
  });

  it('shows password mismatch warning when passwords differ', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordTitle')).toBeInTheDocument();
    });

    const newPwLabel = screen.getByText('settings.profile.newPassword');
    const newPwInput = newPwLabel.parentElement?.querySelector('input');

    const confirmLabel = screen.getByText('settings.profile.confirmPassword');
    const confirmInput = confirmLabel.parentElement?.querySelector('input');

    fireEvent.change(newPwInput!, { target: { value: 'ValidPass123' } });
    fireEvent.change(confirmInput!, { target: { value: 'DifferentPass' } });

    await waitFor(() => {
      expect(screen.getByText('settings.profile.passwordMismatch')).toBeInTheDocument();
    });
  });

  it('password change button is disabled when inputs are incomplete', async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('settings.profile.changePassword')).toBeInTheDocument();
    });

    const changeBtn = screen.getByText('settings.profile.changePassword');
    expect(changeBtn).toBeDisabled();
  });

  it('renders verified badge when email is verified', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('settings.profile.verified')).toBeInTheDocument();
    });
  });

  it('renders delete account button (disabled)', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const deleteBtn = screen.getByText('settings.profile.deleteAccount');
      expect(deleteBtn).toBeDisabled();
    });
  });
});
