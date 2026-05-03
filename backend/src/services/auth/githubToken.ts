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

export type GitHubTokenSource = 'github_integrations' | 'dev_env_fallback' | 'none';

export interface ResolvedGitHubToken {
  token: string | null;
  source: GitHubTokenSource;
}

export interface GitHubTokenDeps {
  readIntegrationRow?: (
    userId: string,
  ) => Promise<{ accessToken: string | null } | null>;
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
  deps: GitHubTokenDeps = {},
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
        if (decrypted) {
          return { token: decrypted, source: 'github_integrations' };
        }
      } catch (error) {
        logger.warn(
          `[github-token] decrypt failed userId=${userId} error=${String(error)}`,
        );
      }
    }
  } catch (error) {
    logger.warn(
      `[github-token] integration lookup failed userId=${userId} error=${String(error)}`,
    );
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
  deps?: GitHubTokenDeps,
): Promise<string | null> {
  const { token } = await resolveGitHubToken(userId, deps);
  return token;
}
