/**
 * Dev-mode bypass for the GitHub integration OAuth dance.
 *
 * Goal: let the bakkal flow (signup → "GitHub ile Bağla" → pipeline) work
 * end-to-end on a dev box that has no real GitHub OAuth App configured.
 *
 * The bypass triggers only when DEV_MODE=true, NODE_ENV !== 'production',
 * and `GITHUB_OAUTH_CLIENT_ID` is unset or still a placeholder. In that case
 * the start route synthesizes a successful OAuth result instead of returning
 * 501. The encrypted token written into `github_integrations` is the env
 * `GITHUB_TOKEN` (preferred so the pipeline can actually call GitHub), or a
 * sentinel string when no real token is available — sentinel writes still
 * mark the user "connected" so the modal dismisses, but pipeline calls will
 * surface a clear `GITHUB_TOKEN_INVALID` error rather than failing silently.
 *
 * Production safety: every check is double-gated on NODE_ENV !== 'production'.
 */

const PLACEHOLDER_PREFIX = '<';

export interface DevBypassEnv {
  DEV_MODE?: string;
  NODE_ENV?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
}

export interface DevBypassDecision {
  bypassEnabled: boolean;
  reason:
    | 'oauth_configured'
    | 'production'
    | 'dev_mode_off'
    | 'bypass_active';
  /** The token to store in github_integrations.access_token (encrypted). */
  fallbackToken: string;
  /** Whether the stored token can actually call GitHub APIs. */
  tokenIsReal: boolean;
}

/** Sentinel value written into github_integrations when no real GITHUB_TOKEN is set. */
export const DEV_BYPASS_SENTINEL_TOKEN = '__AKIS_DEV_MOCK_GITHUB_TOKEN__';

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  if (value.startsWith(PLACEHOLDER_PREFIX)) return true;
  return false;
}

function isRealishToken(value: string | undefined): boolean {
  if (!value) return false;
  if (value.startsWith(PLACEHOLDER_PREFIX)) return false;
  if (value.length < 10) return false;
  // Reject obvious dummies used in test envs.
  if (value === 'ghp_dummy_skip_for_smoke') return false;
  return true;
}

export function evaluateGithubOAuthDevBypass(env: DevBypassEnv): DevBypassDecision {
  if (env.NODE_ENV === 'production') {
    return {
      bypassEnabled: false,
      reason: 'production',
      fallbackToken: '',
      tokenIsReal: false,
    };
  }

  if (env.DEV_MODE !== 'true') {
    return {
      bypassEnabled: false,
      reason: 'dev_mode_off',
      fallbackToken: '',
      tokenIsReal: false,
    };
  }

  const clientIdMissing = isPlaceholder(env.GITHUB_OAUTH_CLIENT_ID);
  const clientSecretMissing = isPlaceholder(env.GITHUB_OAUTH_CLIENT_SECRET);

  if (!clientIdMissing && !clientSecretMissing) {
    return {
      bypassEnabled: false,
      reason: 'oauth_configured',
      fallbackToken: '',
      tokenIsReal: false,
    };
  }

  const tokenIsReal = isRealishToken(env.GITHUB_TOKEN);
  return {
    bypassEnabled: true,
    reason: 'bypass_active',
    fallbackToken: tokenIsReal ? env.GITHUB_TOKEN! : DEV_BYPASS_SENTINEL_TOKEN,
    tokenIsReal,
  };
}
