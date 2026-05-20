/**
 * Unified GitHub token resolver.
 *
 * Reads from the dedicated `github_integrations` table — the integration token
 * is intentionally separate from social login (`oauth_accounts`). A user who
 * signed in with GitHub still has to explicitly OAuth into the integration to
 * get the broader-scoped token (repo) used by the pipeline.
 *
 * Resolution priority:
 *   1. github_integrations (encrypted, AES-256-GCM)
 *   2. env GITHUB_TOKEN (DEV_MODE only — never active in production)
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { githubIntegrations } from '../../db/schema.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { oauthTokenCrypto } from './OAuthTokenCrypto.js';
import { DEV_BYPASS_SENTINEL_TOKEN } from './githubOauthDevBypass.js';

export type GitHubTokenSource = 'github_integrations' | 'dev_env_fallback' | 'none';

export interface ResolvedGitHubToken {
  token: string | null;
  source: GitHubTokenSource;
}

export interface GitHubTokenDeps {
  readIntegrationRow?: (userId: string) => Promise<{ accessToken: string | null } | null>;
  decrypt?: (args: {
    userId: string;
    provider: 'github';
    rawToken: string;
    kind: 'access';
  }) => string | null;
  readEnv?: () => { GITHUB_TOKEN?: string; DEV_MODE?: string };
}

function defaultDeps(): Required<GitHubTokenDeps> {
  return {
    readIntegrationRow: async (userId) => {
      const row = await db.query.githubIntegrations.findFirst({
        where: eq(githubIntegrations.userId, userId),
        columns: { accessToken: true },
      });
      return row ? { accessToken: row.accessToken ?? null } : null;
    },
    decrypt: (args) => oauthTokenCrypto.decryptForUse(args),
    readEnv: () => {
      const env = getEnv();
      return {
        GITHUB_TOKEN: env.GITHUB_TOKEN,
        DEV_MODE: process.env.DEV_MODE,
      };
    },
  };
}

export async function resolveGitHubToken(
  userId: string,
  deps: GitHubTokenDeps = {}
): Promise<ResolvedGitHubToken> {
  const d = { ...defaultDeps(), ...deps };

  // 1. Preferred: integration token (encrypted)
  try {
    const row = await d.readIntegrationRow(userId);
    const raw = row?.accessToken ?? null;

    if (raw) {
      try {
        const decrypted = d.decrypt({
          userId,
          provider: 'github',
          rawToken: raw,
          kind: 'access',
        });
        if (decrypted && decrypted !== DEV_BYPASS_SENTINEL_TOKEN) {
          return { token: decrypted, source: 'github_integrations' };
        }
        if (decrypted === DEV_BYPASS_SENTINEL_TOKEN) {
          // Connected via DEV_MODE bypass without a real GITHUB_TOKEN —
          // user is "linked" so the modal stays dismissed, but pipeline
          // calls must fail with a clear "no token" signal.
          logger.warn(`[github-token] dev-bypass sentinel detected userId=${userId}; skipping`);
        }
      } catch (error) {
        logger.warn(`[github-token] decrypt failed userId=${userId} error=${String(error)}`);
      }
    }
  } catch (error) {
    logger.warn(`[github-token] integration lookup failed userId=${userId} error=${String(error)}`);
  }

  // 2. DEV_MODE env fallback — never active in production (defense-in-depth
  //    even if a misconfigured prod deploy sets DEV_MODE=true).
  const envVars = d.readEnv();
  if (envVars.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production') {
    const envToken = envVars.GITHUB_TOKEN;
    if (envToken && !envToken.startsWith('<') && envToken.length > 10) {
      return { token: envToken, source: 'dev_env_fallback' };
    }
  }

  return { token: null, source: 'none' };
}

/**
 * Thin wrapper for call-sites that only need the token string.
 * Preserves the historical `getGitHubToken(userId): Promise<string | null>` signature.
 */
export async function getGitHubToken(
  userId: string,
  deps?: GitHubTokenDeps
): Promise<string | null> {
  const { token } = await resolveGitHubToken(userId, deps);
  return token;
}

/**
 * PR-V-github-401-graceful — clear a user's stored GitHub integration token.
 *
 * Called by the orchestrator when GitHub returns 401 ("Bad credentials") on a
 * real API call. The stored token is no longer usable — either the user
 * revoked the OAuth grant from github.com or GitHub rotated it. Leaving the
 * row in place would cause the next pipeline to retry the same dead token
 * indefinitely; deleting it forces the UI back through the "Connect GitHub"
 * flow.
 *
 * Idempotent: deleting an already-empty row is a no-op. Logs (but does not
 * rethrow) DB errors — the caller is already in a failure path, swallowing
 * a secondary DB error keeps the user-facing error code (GITHUB_TOKEN_INVALID)
 * stable instead of degrading to a generic 500.
 *
 * @returns `true` when the row was deleted, `false` when no row existed or
 *          the delete failed. Used by tests to assert wiring.
 */
export async function invalidateUserGitHubToken(
  userId: string,
  deps: {
    deleteIntegrationRow?: (userId: string) => Promise<{ rowCount: number }>;
  } = {}
): Promise<boolean> {
  const deleteRow =
    deps.deleteIntegrationRow ??
    (async (id: string) => {
      const result = await db.delete(githubIntegrations).where(eq(githubIntegrations.userId, id));
      // drizzle returns a PgQueryResult-like object; rowCount is optional.
      const rc = (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
      return { rowCount: rc };
    });

  try {
    const { rowCount } = await deleteRow(userId);
    logger.warn(
      { userId, rowCount },
      '[github-token] invalidateUserGitHubToken: stale token cleared after 401'
    );
    return rowCount > 0;
  } catch (error) {
    logger.error(
      { userId, error: String(error) },
      '[github-token] invalidateUserGitHubToken: delete failed (swallowing)'
    );
    return false;
  }
}
