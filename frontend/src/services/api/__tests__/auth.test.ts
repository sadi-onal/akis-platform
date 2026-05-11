import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
  getAuthBaseUrl: () => 'http://localhost:3000',
}));

const { AuthAPI } = await import('../auth');

const ORIGINAL_FETCH = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function json(status: number, body: unknown, statusText = '') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AuthAPI request helper', () => {
  it('serializes body, sets Content-Type, and credentials include', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    await AuthAPI.signup({ name: 'Ada', email: 'a@b.c', password: 'p' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/auth/signup');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'Ada', email: 'a@b.c', password: 'p' });
  });

  it('omits Content-Type when there is no body (me)', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    await AuthAPI.me();
    const [, init] = mockFetch.mock.calls[0];
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns undefined on 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await AuthAPI.logout();
    expect(res).toBeUndefined();
  });

  it('maps 404 to user-friendly Turkish-ish "Service temporarily unavailable" copy', async () => {
    mockFetch.mockResolvedValueOnce(json(404, { error: 'not found' }));
    await expect(AuthAPI.me()).rejects.toThrow(/Service temporarily unavailable/);
  });

  it('maps 5xx to "Server error. Please try again later."', async () => {
    mockFetch.mockResolvedValueOnce(json(500, { error: 'oops' }));
    await expect(AuthAPI.me()).rejects.toThrow(/Server error/);
  });

  it('parses string-form error field', async () => {
    mockFetch.mockResolvedValueOnce(json(400, { error: 'Invalid input' }));
    await expect(AuthAPI.me()).rejects.toThrow('Invalid input');
  });

  it('parses object-form error.message', async () => {
    mockFetch.mockResolvedValueOnce(json(400, { error: { message: 'Bad creds' } }));
    await expect(AuthAPI.me()).rejects.toThrow('Bad creds');
  });

  it('falls back to errorData.message when error is missing', async () => {
    mockFetch.mockResolvedValueOnce(json(400, { message: 'top-level' }));
    await expect(AuthAPI.me()).rejects.toThrow('top-level');
  });

  it('falls back to raw text when JSON parsing fails', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('plain text error', { status: 400, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(AuthAPI.me()).rejects.toThrow('plain text error');
  });

  it('treats body-less error responses as "Request failed"', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(AuthAPI.me()).rejects.toThrow('Request failed');
  });

  it('maps body messages containing "not found" to friendly copy', async () => {
    mockFetch.mockResolvedValueOnce(json(400, { error: 'user not found' }));
    await expect(AuthAPI.me()).rejects.toThrow(/Service temporarily unavailable/);
  });
});

describe('AuthAPI endpoints', () => {
  function expectCall(method: string, path: string, body?: unknown) {
    const last = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(last[0]).toBe(`http://localhost:3000${path}`);
    expect(last[1].method ?? 'GET').toBe(method);
    if (body !== undefined) {
      expect(JSON.parse(last[1].body)).toEqual(body);
    } else {
      expect(last[1].body).toBeUndefined();
    }
  }

  it('signupStart POSTs /auth/signup/start', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { userId: 'u', email: 'a', message: 'm', status: 's' }));
    await AuthAPI.signupStart({ firstName: 'A', lastName: 'B', email: 'a@b.c' });
    expectCall('POST', '/auth/signup/start', { firstName: 'A', lastName: 'B', email: 'a@b.c' });
  });

  it('signupPassword POSTs /auth/signup/password', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { ok: true, message: 'ok' }));
    await AuthAPI.signupPassword({ userId: 'u', password: 'p' });
    expectCall('POST', '/auth/signup/password', { userId: 'u', password: 'p' });
  });

  it('verifyEmail POSTs /auth/verify-email', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { user: { id: 'u', name: 'n', email: 'e' }, message: 'ok' }));
    await AuthAPI.verifyEmail({ userId: 'u', code: '123456' });
    expectCall('POST', '/auth/verify-email', { userId: 'u', code: '123456' });
  });

  it('resendCode POSTs /auth/resend-code', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { ok: true, message: 'ok' }));
    await AuthAPI.resendCode({ userId: 'u' });
    expectCall('POST', '/auth/resend-code', { userId: 'u' });
  });

  it('loginStart POSTs /auth/login/start', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { userId: 'u', email: 'e', requiresPassword: true, status: 's' }));
    await AuthAPI.loginStart({ email: 'a@b.c' });
    expectCall('POST', '/auth/login/start', { email: 'a@b.c' });
  });

  it('loginComplete POSTs /auth/login/complete', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { user: { id: 'u', name: 'n', email: 'e' } }));
    await AuthAPI.loginComplete({ userId: 'u', password: 'p' });
    expectCall('POST', '/auth/login/complete', { userId: 'u', password: 'p' });
  });

  it('login POSTs /auth/login (legacy)', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    await AuthAPI.login({ email: 'a@b.c', password: 'p' });
    expectCall('POST', '/auth/login', { email: 'a@b.c', password: 'p' });
  });

  it('me GETs /auth/me', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    const res = await AuthAPI.me();
    expectCall('GET', '/auth/me');
    expect(res.id).toBe('u');
  });

  it('logout POSTs /auth/logout with no body', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { ok: true }));
    await AuthAPI.logout();
    expectCall('POST', '/auth/logout');
  });

  it('validateInvite GETs /auth/invite/validate with encoded token', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { valid: true }));
    await AuthAPI.validateInvite('abc def&xyz');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:3000/auth/invite/validate?token=abc%20def%26xyz');
  });

  it('acceptInvite POSTs /auth/invite/accept', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { user: { id: 'u', name: 'n', email: 'e' }, message: 'ok' }));
    await AuthAPI.acceptInvite({ token: 't', firstName: 'A', lastName: 'B', password: 'p' });
    expectCall('POST', '/auth/invite/accept', { token: 't', firstName: 'A', lastName: 'B', password: 'p' });
  });

  it('getProfile GETs /auth/profile', async () => {
    mockFetch.mockResolvedValueOnce(json(200, {
      id: 'u', name: 'n', email: 'e', role: 'user',
      emailVerified: true, githubUsername: null, githubAvatarUrl: null,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    await AuthAPI.getProfile();
    expectCall('GET', '/auth/profile');
  });

  it('updateProfile PUTs /auth/profile', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n2', email: 'e' }));
    await AuthAPI.updateProfile({ name: 'n2' });
    expectCall('PUT', '/auth/profile', { name: 'n2' });
  });

  it('updateAvatar PUTs /auth/avatar', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    await AuthAPI.updateAvatar('data:image/png;base64,aaaa');
    expectCall('PUT', '/auth/avatar', { avatarUrl: 'data:image/png;base64,aaaa' });
  });

  it('updateAvatar accepts null to clear avatar', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { id: 'u', name: 'n', email: 'e' }));
    await AuthAPI.updateAvatar(null);
    expectCall('PUT', '/auth/avatar', { avatarUrl: null });
  });

  it('changePassword PUTs /auth/password', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { ok: true }));
    await AuthAPI.changePassword({ currentPassword: 'a', newPassword: 'b' });
    expectCall('PUT', '/auth/password', { currentPassword: 'a', newPassword: 'b' });
  });

  it('deleteAccount DELETEs /auth/account', async () => {
    mockFetch.mockResolvedValueOnce(json(200, { ok: true }));
    await AuthAPI.deleteAccount();
    expectCall('DELETE', '/auth/account');
  });
});
