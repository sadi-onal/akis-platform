import { getAuthBaseUrl } from './config';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Get base URL at runtime (not module init) to ensure window.location is available
  const BASE = getAuthBaseUrl();
  
  // Only set Content-Type: application/json if there's a body
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> ?? {}),
  };
  
  // Add Content-Type only when body is present
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers,
    ...init,
  });

  if (!response.ok) {
    const rawMessage = (await response.text()) || 'Request failed';
    
    // Try to parse JSON error response
    let errorMessage: string;
    try {
      const errorData = JSON.parse(rawMessage);
      const errField = errorData.error;
      errorMessage = (typeof errField === 'string' ? errField : errField?.message) || errorData.message || rawMessage;
    } catch {
      errorMessage = rawMessage;
    }
    
    // Convert technical errors to user-friendly messages
    if (response.status === 404 || (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('not found'))) {
      errorMessage = 'Service temporarily unavailable. Please try again.';
    } else if (response.status >= 500) {
      errorMessage = 'Server error. Please try again later.';
    }
    
    throw new Error(errorMessage);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  /** User-uploaded avatar or cached GitHub avatar; null → UI renders initials. Issue #385. */
  avatarUrl?: string | null;
  status?: string;
  emailVerified?: boolean;
  dataSharingConsent?: boolean | null;
  hasSeenBetaWelcome?: boolean;
};

export type UserProfile = {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
  githubUsername: string | null;
  githubAvatarUrl: string | null;
  createdAt: string;
};

export type SignupStartResponse = {
  userId: string;
  email: string;
  message: string;
  status: string;
};

export type LoginStartResponse = {
  userId: string;
  email: string;
  requiresPassword: boolean;
  status: string;
};

export type LoginCompleteResponse = {
  user: AuthUser;
};

export type SignupPasswordResponse = {
  ok: boolean;
  message: string;
  verificationBypassed?: boolean;
  user?: AuthUser;
};

export type VerifyEmailResponse = {
  user: AuthUser;
  message: string;
};

export type InviteValidateResponse = {
  valid: boolean;
  email?: string;
  inviterName?: string;
  expiresAt?: string;
  existingUser?: boolean;
};

export type InviteAcceptResponse = {
  user: AuthUser;
  message: string;
};

export const AuthAPI = {
  // Legacy single-step methods (deprecated)
  signup: (data: { name: string; email: string; password: string }) =>
    request<AuthUser>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  login: (data: { email: string; password: string }) =>
    request<AuthUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  
  // Multi-step signup flow
  signupStart: (data: { firstName: string; lastName: string; email: string }) =>
    request<SignupStartResponse>('/auth/signup/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  signupPassword: (data: { userId: string; password: string }) =>
    request<SignupPasswordResponse>('/auth/signup/password', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  verifyEmail: (data: { userId: string; code: string }) =>
    request<VerifyEmailResponse>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  resendCode: (data: { userId: string }) =>
    request<{ ok: boolean; message: string }>('/auth/resend-code', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  
  // Multi-step login flow
  loginStart: (data: { email: string }) =>
    request<LoginStartResponse>('/auth/login/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  loginComplete: (data: { userId: string; password: string }) =>
    request<LoginCompleteResponse>('/auth/login/complete', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  
  // Session management
  me: () => request<AuthUser>('/auth/me'),
  logout: () =>
    request<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
      // No body - server accepts empty POST for logout
    }),

  // Invite flow (WL-1)
  validateInvite: (token: string) =>
    request<InviteValidateResponse>(`/auth/invite/validate?token=${encodeURIComponent(token)}`),
  acceptInvite: (data: { token: string; firstName: string; lastName: string; password: string }) =>
    request<InviteAcceptResponse>('/auth/invite/accept', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Profile & Account management
  getProfile: () => request<UserProfile>('/auth/profile'),
  updateProfile: (data: { name?: string; email?: string }) =>
    request<AuthUser>('/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  /**
   * Set (or clear with null) the user-uploaded avatar. Issue #385.
   * `avatarUrl` must be a data URL (`data:image/png;base64,...`) encoded client-side
   * from a file picker, or null to revert to the GitHub-cached avatar / initials.
   */
  updateAvatar: (avatarUrl: string | null) =>
    request<AuthUser>('/auth/avatar', {
      method: 'PUT',
      body: JSON.stringify({ avatarUrl }),
    }),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteAccount: () =>
    request<{ ok: boolean }>('/auth/account', { method: 'DELETE' }),
};

