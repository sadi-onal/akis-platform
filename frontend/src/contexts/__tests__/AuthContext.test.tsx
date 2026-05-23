import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '../AuthContext';

const mockMe = vi.fn();

vi.mock('../../services/api/auth', () => ({
  AuthAPI: {
    me: () => mockMe(),
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
  },
}));

function Probe() {
  const { user, loading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'done'}</span>
      <span data-testid="user">{user ? user.email : 'anon'}</span>
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    mockMe.mockReset();
  });

  it('resolves the session on landing route (/) — regression for direct-URL session loss', async () => {
    mockMe.mockResolvedValueOnce({ id: 'u1', name: 'Omer', email: 'omer@example.com' });

    renderAt('/');

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('done'));
    expect(screen.getByTestId('user')).toHaveTextContent('omer@example.com');
    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  it('resolves the session on /login — regression for direct-URL session loss', async () => {
    mockMe.mockResolvedValueOnce({ id: 'u1', name: 'Omer', email: 'omer@example.com' });

    renderAt('/login');

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('done'));
    expect(screen.getByTestId('user')).toHaveTextContent('omer@example.com');
    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  it('resolves the session on /chat (already working — guards against regression)', async () => {
    mockMe.mockResolvedValueOnce({ id: 'u1', name: 'Omer', email: 'omer@example.com' });

    renderAt('/chat');

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('done'));
    expect(screen.getByTestId('user')).toHaveTextContent('omer@example.com');
  });

  it('treats /auth/me 401 as anonymous on public routes (no error surfaced)', async () => {
    mockMe.mockRejectedValueOnce(new Error('Unauthorized'));

    renderAt('/');

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('done'));
    expect(screen.getByTestId('user')).toHaveTextContent('anon');
  });
});
