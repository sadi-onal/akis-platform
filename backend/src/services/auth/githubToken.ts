/**
 * Unified GitHub token resolver.
 *
 * Single source of truth for "what's this user's GitHub access token?".
 * Before this helper, two separate implementations existed:
 *   - backend/src/api/github.ts → read users.githubToken (legacy PAT)
 *   - backend/src/api/integrations.ts → read oauthAccounts (OAuth)
 * They disagreed, causing the UI to show contradictory "connected" state
 * (see prod smoke 2026-04-17, issue #381 / BUG-01).
 *
 * Resolution priority:
 *   1. oauthAccounts (GitHub provider) — encrypted, preferred
 *   2. users.githubToken — legacy plaintext (PAT), kept for backfill grace period
 *   3. Dev bootstrap placeholder → env SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN / GITHUB_TOKEN
 *   4. env GITHUB_TOKEN fallback (DEV_MODE only)
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { oauthAccounts, users } from '../../db/schema.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { oauthTokenCrypto } from './OAuthTokenCrypto.js';

/**
 * Placeholder value written to `oauth_accounts.access_token` when a user is
 * bootstrapped via the dev-env shortcut. Kept as a local literal rather than
 * imported from AgentOrchestrator so unit tests (and CI without DATABASE_URL)
 * don't drag the full orchestrator module into the import graph, which
 * transitively pulls lib/env.ts and tries to validate env at load time.
 *
 * Must match AgentOrchestrator.DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER exactly.
 */
const DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER = '__DEV_GITHUB_BOOTSTRAP__';

export type GitHubTokenSource =
  | 'oauth_accounts'
  | 'legacy_users_column'
  | 'dev_bootstrap'
  | 'dev_env_fallback'
  | 'none';

export interface ResolvedGitHubToken {
  token: string | null;
  source: GitHubTokenSource;
}

export interface GitHubTokenDeps {
  readOauthRow?: (userId: string) => Promise<{ accessToken: string | null } | null>;
  readLegacyRow?: (userId: string) => Promise<{ githubToken: string | null } | null>;
  decrypt?: (args: { userId: string; provider: 'github'; rawToken: string; kind: 'access' }) => string | null;
  readEnv?: () => {
    GITHUB_TOKEN?: string;
    SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN?: string;
    DEV_MODE?: string;
    SCRIBE_DEV_GITHUB_BOOTSTRAP?: string;
  };
}

function defaultDeps(): Required<GitHubTokenDeps> {
  return {
    readOauthRow: async (userId) => {
      const row = await db.query.oauthAccounts.findFirst({
        where: and(
          eq(oauthAccounts.userId, userId),
          eq(oauthAccounts.provider, 'github'),
        ),
      });
      return row ? { accessToken: row.accessToken ?? null } : null;
    },
    readLegacyRow: async (userId) => {
      const row = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { githubToken: true },
      });
      return row ? { githubToken: row.githubToken ?? null } : null;
    },
    decrypt: (args) => oauthTokenCrypto.decryptForUse(args),
    readEnv: () => {
      const env = getEnv();
      return {
        GITHUB_TOKEN: env.GITHUB_TOKEN,
        SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN: env.SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN,
        DEV_MODE: process.env.DEV_MODE,
        SCRIBE_DEV_GITHUB_BOOTSTRAP: process.env.SCRIBE_DEV_GITHUB_BOOTSTRAP,
      };
    },
  };
}

/**
 * Resolve a GitHub token for the given user, checking all storage layers.
 * Returns both the token and the source it came from (useful for logging + metrics).
 *
 * Deps argument allows injecting fakes in tests without touching the live DB/env.
 */
export async function resolveGitHubToken(
  userId: string,
  deps: GitHubTokenDeps = {},
): Promise<ResolvedGitHubToken> {
  const d = { ...defaultDeps(), ...deps };
  // 1. Preferred: OAuth account (encrypted)
  try {
    const oauthRow = await d.readOauthRow(userId);
    const rawOauth = oauthRow?.accessToken ?? null;

    if (rawOauth && rawOauth !== DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER) {
      try {
        const decrypted = d.decrypt({
          userId,
          provider: 'github',
          rawToken: rawOauth,
          kind: 'access',
        });
        if (decrypted) {
          logger.debug(`[github-token] resolved userId=${userId} source=oauth_accounts`);
          return { token: decrypted, source: 'oauth_accounts' };
        }
      } catch (error) {
        logger.warn(
          `[github-token] decrypt failed userId=${userId} source=oauth_accounts error=${String(error)}`,
        );
        // Fall through to legacy — token record exists but is corrupt; try legacy next
      }
    }

    // Dev bootstrap placeholder — expand to env
    if (rawOauth === DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER) {
      const envVars = d.readEnv();
      if (envVars.SCRIBE_DEV_GITHUB_BOOTSTRAP === 'true') {
        const bootstrap = envVars.SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN || envVars.GITHUB_TOKEN || null;
        if (bootstrap) {
          logger.debug(`[github-token] resolved userId=${userId} source=dev_bootstrap`);
          return { token: bootstrap, source: 'dev_bootstrap' };
        }
      }
    }
  } catch (error) {
    logger.warn(
      `[github-token] oauth lookup failed userId=${userId} error=${String(error)}`,
    );
    // Continue to legacy fallback
  }

  // 2. Legacy: users.githubToken (plaintext PAT)
  try {
    const userRow = await d.readLegacyRow(userId);
    if (userRow?.githubToken) {
      logger.info(
        `[github-token] resolved userId=${userId} source=legacy_users_column (deprecation: migrate to oauth_accounts)`,
      );
      return { token: userRow.githubToken, source: 'legacy_users_column' };
    }
  } catch (error) {
    logger.warn(
      `[github-token] legacy lookup failed userId=${userId} error=${String(error)}`,
    );
  }

  // 3. DEV_MODE env fallback
  const envVars = d.readEnv();
  if (envVars.DEV_MODE === 'true') {
    const envToken = envVars.GITHUB_TOKEN;
    if (envToken && !envToken.startsWith('<') && envToken.length > 10) {
      logger.debug(`[github-token] resolved userId=${userId} source=dev_env_fallback`);
      return { token: envToken, source: 'dev_env_fallback' };
    }
  }

  logger.debug(`[github-token] not found userId=${userId}`);
  return { token: null, source: 'none' };
}

/**
 * Thin wrapper for call-sites that only need the token string.
 * Preserves the historical `getGitHubToken(userId): Promise<string | null>` signature.
 */
export async function getGitHubToken(
  userId: string,
  deps?: GitHubTokenDeps,
): Promise<string | null> {
  const { token } = await resolveGitHubToken(userId, deps);
  return token;
}
