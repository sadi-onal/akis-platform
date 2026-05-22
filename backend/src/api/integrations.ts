/**
 * Integrations API - OAuth-based GitHub + Atlassian integration + Jira/Confluence
 *
 * GitHub:
 *   GET /api/integrations/github/oauth/start
 *   GET /api/integrations/github/oauth/callback
 *   GET /api/integrations/github/status
 *   DELETE /api/integrations/github
 *   GET /api/integrations/github/owners
 *   GET /api/integrations/github/repos
 *   GET /api/integrations/github/branches
 *
 * Atlassian OAuth 2.0 (3LO) - Single OAuth for Jira + Confluence:
 *   GET /api/integrations/atlassian/oauth/start
 *   GET /api/integrations/atlassian/oauth/callback (CANONICAL)
 *   GET /api/integrations/atlassian/status
 *   POST /api/integrations/atlassian/disconnect
 *
 * Jira/Confluence (legacy API token - soft deprecated):
 *   GET /api/integrations - List all integration statuses
 *   POST /api/integrations/jira - Connect Jira (API token)
 *   GET /api/integrations/jira/status
 *   POST /api/integrations/jira/test - Test connection
 *   DELETE /api/integrations/jira
 *   POST /api/integrations/confluence - Connect Confluence (API token)
 *   GET /api/integrations/confluence/status
 *   POST /api/integrations/confluence/test - Test connection
 *   DELETE /api/integrations/confluence
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'crypto';
import { getEnv } from '../config/env.js';
import { requireAuth } from '../utils/auth.js';
import { db } from '../db/client.js';
import { githubIntegrations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  getAuthorizationUrl,
  finishOAuth,
  getConnectionStatus,
  deleteUserTokens as deleteAtlassianTokens,
} from '../services/atlassian/AtlassianMcpClient.js';
import { JiraMCPService } from '../services/mcp/adapters/JiraMCPService.js';
import { McpGateway } from '../services/mcp/McpGateway.js';
import { oauthTokenCrypto, OAuthTokenCryptoError } from '../services/auth/OAuthTokenCrypto.js';
import { getGitHubToken } from '../services/auth/githubToken.js';
import { evaluateGithubOAuthDevBypass } from '../services/auth/githubOauthDevBypass.js';
import { logger } from '../lib/logger.js';

// GitHub API helper
const mcpGateway = new McpGateway();

async function fetchFromGitHub<T>(
  endpoint: string,
  accessToken: string,
  correlationId?: string
): Promise<T> {
  return mcpGateway.fetchGitHubJson<T>(endpoint, accessToken, correlationId);
}

// GitHub token resolution moved to services/auth/githubToken.ts (unified resolver).
// See issue #381 / BUG-01 — dual storage caused UI inconsistency.

export async function integrationsRoutes(fastify: FastifyInstance) {
  // Resolve frontend URL for redirects (APP_PUBLIC_URL is optional, fallback to FRONTEND_URL)
  const appPublicUrl = getEnv().APP_PUBLIC_URL || getEnv().FRONTEND_URL;

  // GET /api/integrations/github/oauth/start - Start OAuth flow
  fastify.get(
    '/api/integrations/github/oauth/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Require AKIS session
        const user = await requireAuth(request);
        const config = getEnv();

        // DEV_MODE: bypass real GitHub OAuth when credentials are not configured.
        // Lets the bakkal flow be exercised end-to-end on a dev box without a
        // real OAuth App. Production-safe: gated on NODE_ENV !== 'production'.
        const bypass = evaluateGithubOAuthDevBypass({
          DEV_MODE: process.env.DEV_MODE,
          NODE_ENV: config.NODE_ENV,
          GITHUB_OAUTH_CLIENT_ID: config.GITHUB_OAUTH_CLIENT_ID,
          GITHUB_OAUTH_CLIENT_SECRET: config.GITHUB_OAUTH_CLIENT_SECRET,
          GITHUB_TOKEN: config.GITHUB_TOKEN,
        });

        if (bypass.bypassEnabled) {
          logger.warn(
            `[integrations] DEV_MODE GitHub OAuth bypass active for user ${user.id}; tokenIsReal=${bypass.tokenIsReal}`
          );
          try {
            const encryptedAccessToken = oauthTokenCrypto.encryptForStorage({
              userId: user.id,
              provider: 'github',
              token: bypass.fallbackToken,
              kind: 'access',
            });

            const existing = await db.query.githubIntegrations.findFirst({
              where: eq(githubIntegrations.userId, user.id),
            });

            const devLogin = `dev-user-${user.id.slice(0, 8)}`;
            if (existing) {
              await db
                .update(githubIntegrations)
                .set({
                  providerAccountId: existing.providerAccountId || `dev-${user.id}`,
                  login: existing.login || devLogin,
                  scope: 'read:user user:email repo',
                  accessToken: encryptedAccessToken,
                  updatedAt: new Date(),
                })
                .where(eq(githubIntegrations.userId, user.id));
            } else {
              await db.insert(githubIntegrations).values({
                userId: user.id,
                providerAccountId: `dev-${user.id}`,
                login: devLogin,
                avatarUrl: null,
                scope: 'read:user user:email repo',
                accessToken: encryptedAccessToken,
              });
            }

            return reply
              .code(302)
              .header('Location', `${appPublicUrl}/chat?github=connected`)
              .send();
          } catch (devErr) {
            if (
              devErr instanceof OAuthTokenCryptoError &&
              devErr.code === 'OAUTH_TOKEN_ENCRYPTION_KEY_MISSING'
            ) {
              return reply.code(503).send({
                error: {
                  code: 'OAUTH_ENCRYPTION_KEY_MISSING',
                  message:
                    'AI_KEY_ENCRYPTION_KEY is not configured — cannot store dev-bypass token securely.',
                },
              });
            }
            logger.error(`[integrations] DEV_MODE bypass failed: ${devErr}`);
            const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=dev_bypass_failed`;
            return reply.code(302).header('Location', errorUrl).send();
          }
        }

        // Check OAuth configuration
        if (!config.GITHUB_OAUTH_CLIENT_ID || !config.GITHUB_OAUTH_CLIENT_SECRET) {
          return reply.code(501).send({
            error: {
              code: 'GITHUB_OAUTH_NOT_CONFIGURED',
              message:
                'GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET env vars.',
            },
          });
        }

        // Note: callback URL is computed from FRONTEND_URL below; no separate
        // env var is required (the previous check here was always wrong on prod).

        // Generate CSRF state token
        const state = randomBytes(32).toString('hex');

        // Store state in httpOnly cookie (10 min TTL)
        reply.setCookie('github_oauth_state', state, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 10 * 60, // 10 minutes
          path: '/',
        });

        // Build GitHub authorize URL
        // Use the unified auth OAuth callback URL (auth.oauth.ts detects integration flow
        // via cookie and forwards to /api/integrations/github/oauth/callback)
        const oauthCallbackUrl = `${config.FRONTEND_URL}/auth/oauth/github/callback`;
        const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
        githubAuthUrl.searchParams.set('client_id', config.GITHUB_OAUTH_CLIENT_ID);
        githubAuthUrl.searchParams.set('redirect_uri', oauthCallbackUrl);
        githubAuthUrl.searchParams.set('scope', 'read:user user:email repo');
        githubAuthUrl.searchParams.set('state', state);

        // Redirect to GitHub
        return reply.code(302).header('Location', githubAuthUrl.toString()).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // User not logged in - redirect to login with returnTo
          const _config = getEnv();
          const returnTo = encodeURIComponent('/settings?tab=integrations');
          return reply
            .code(302)
            .header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`)
            .send();
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/github/oauth/callback - OAuth callback from GitHub
  fastify.get(
    '/api/integrations/github/oauth/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, state: receivedState } = request.query as { code?: string; state?: string };
      const config = getEnv();

      try {
        // Verify we have an AKIS session
        const user = await requireAuth(request);

        // Validate code parameter
        if (!code) {
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=missing_code`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Validate state (CSRF protection)
        const storedState = request.cookies?.github_oauth_state;
        if (!storedState || storedState !== receivedState) {
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=state_mismatch`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Clear state cookie
        reply.clearCookie('github_oauth_state', { path: '/' });

        // Exchange code for access token (via gateway boundary)
        // redirect_uri must match what was sent in the authorization request
        const tokenExchangeRedirectUri = `${config.FRONTEND_URL}/auth/oauth/github/callback`;
        const tokenData = await mcpGateway
          .exchangeGitHubOAuthCode(
            {
              code,
              clientId: config.GITHUB_OAUTH_CLIENT_ID!,
              clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET!,
              redirectUri: tokenExchangeRedirectUri,
            },
            request.id
          )
          .catch(() => null);

        if (!tokenData) {
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=token_exchange_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        if (tokenData.error || !tokenData.access_token) {
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=token_missing`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        const accessToken = tokenData.access_token;
        const grantedScope = tokenData.scope ?? '';
        let encryptedAccessToken: string;

        try {
          encryptedAccessToken = oauthTokenCrypto.encryptForStorage({
            userId: user.id,
            provider: 'github',
            token: accessToken,
            kind: 'access',
          });
        } catch (error) {
          if (
            error instanceof OAuthTokenCryptoError &&
            error.code === 'OAUTH_TOKEN_ENCRYPTION_KEY_MISSING'
          ) {
            const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=encryption_key_missing`;
            return reply.code(302).header('Location', errorUrl).send();
          }

          logger.error(`[integrations] Failed to encrypt GitHub OAuth token: ${error}`);
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=token_storage_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Fetch GitHub user info (via gateway boundary)
        const githubUser = await mcpGateway
          .fetchGitHubUser(accessToken, request.id)
          .catch(() => null);
        if (!githubUser) {
          const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=user_fetch_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Upsert into github_integrations (separate from login oauth_accounts).
        const existingIntegration = await db.query.githubIntegrations.findFirst({
          where: eq(githubIntegrations.userId, user.id),
        });

        if (existingIntegration) {
          await db
            .update(githubIntegrations)
            .set({
              providerAccountId: githubUser.id.toString(),
              login: githubUser.login,
              avatarUrl: githubUser.avatar_url ?? null,
              scope: grantedScope,
              accessToken: encryptedAccessToken,
              updatedAt: new Date(),
            })
            .where(eq(githubIntegrations.userId, user.id));
        } else {
          await db.insert(githubIntegrations).values({
            userId: user.id,
            providerAccountId: githubUser.id.toString(),
            login: githubUser.login,
            avatarUrl: githubUser.avatar_url ?? null,
            scope: grantedScope,
            accessToken: encryptedAccessToken,
          });
        }

        // Redirect back to chat with success — frontend dismisses the modal
        const successUrl = `${appPublicUrl}/chat?github=connected`;
        return reply.code(302).header('Location', successUrl).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // Session lost during callback - redirect to login
          const returnTo = encodeURIComponent('/settings?tab=integrations');
          return reply
            .code(302)
            .header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`)
            .send();
        }

        // Unexpected error
        const errorUrl = `${appPublicUrl}/settings?tab=integrations&github=error&reason=internal_error`;
        return reply.code(302).header('Location', errorUrl).send();
      }
    }
  );

  // GET /api/integrations/github/status - Check GitHub connection status
  fastify.get(
    '/api/integrations/github/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // DOGFOOD_MODE: pretend the user is connected so the frontend JIT
        // gate (ChatPageLayout / useHandleSend) doesn't intercept on every
        // new conversation. No real `github_integrations` row required.
        // Defense in depth: env.ts superRefine rejects DOGFOOD_MODE=true at
        // boot in production; this runtime check belt-and-braces the same
        // production guard at the call site.
        if (process.env.DOGFOOD_MODE === 'true' && process.env.NODE_ENV !== 'production') {
          return reply.code(200).send({
            connected: true,
            login: 'dogfood-tester',
            avatarUrl: null,
            scope: 'repo,read:user,user:email',
          });
        }

        const integration = await db.query.githubIntegrations.findFirst({
          where: eq(githubIntegrations.userId, user.id),
          columns: {
            login: true,
            avatarUrl: true,
            scope: true,
          },
        });

        if (!integration) {
          return reply.code(200).send({ connected: false });
        }

        return reply.code(200).send({
          connected: true,
          login: integration.login,
          avatarUrl: integration.avatarUrl ?? null,
          scope: integration.scope,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // DELETE /api/integrations/github - Disconnect GitHub
  // Note: TypeScript definitions for Fastify may not include 'delete' method in some versions
  // Using type assertion as runtime supports it
  (fastify as FastifyInstance & { delete: typeof fastify.get }).delete(
    '/api/integrations/github',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        await db.delete(githubIntegrations).where(eq(githubIntegrations.userId, user.id));

        return reply.code(200).send({
          ok: true,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/github/owners
  fastify.get(
    '/api/integrations/github/owners',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const token = await getGitHubToken(user.id);

        if (!token) {
          return reply.code(412).send({
            error: {
              code: 'GITHUB_NOT_CONNECTED',
              message: 'GitHub is not connected. Please connect GitHub first.',
            },
          });
        }

        // Get authenticated user
        const githubUser = await fetchFromGitHub<{ login: string; avatar_url: string }>(
          '/user',
          token,
          request.id
        );

        // Get user's organizations
        const orgs = await fetchFromGitHub<Array<{ login: string; avatar_url: string }>>(
          '/user/orgs',
          token,
          request.id
        );

        const owners = [
          { login: githubUser.login, type: 'User' as const, avatarUrl: githubUser.avatar_url },
          ...orgs.map((org) => ({
            login: org.login,
            type: 'Organization' as const,
            avatarUrl: org.avatar_url,
          })),
        ];

        return reply.code(200).send({ owners });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/github/repos
  fastify.get(
    '/api/integrations/github/repos',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const { owner } = request.query as { owner?: string };

        if (!owner) {
          return reply.code(400).send({
            error: { code: 'MISSING_OWNER', message: 'owner query parameter is required' },
          });
        }

        const token = await getGitHubToken(user.id);

        if (!token) {
          return reply.code(412).send({
            error: {
              code: 'GITHUB_NOT_CONNECTED',
              message: 'GitHub is not connected. Please connect GitHub first.',
            },
          });
        }

        // Fetch repos for the owner
        // First check if owner is the authenticated user or an org
        const githubUser = await fetchFromGitHub<{ login: string }>('/user', token, request.id);

        let rawRepos: Array<{
          name: string;
          full_name: string;
          default_branch: string;
          private: boolean;
          description: string | null;
        }>;

        if (owner === githubUser.login) {
          // User's own repos
          rawRepos = await fetchFromGitHub(
            '/user/repos?per_page=100&sort=updated',
            token,
            request.id
          );
        } else {
          // Organization repos
          rawRepos = await fetchFromGitHub(
            `/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
            token,
            request.id
          );
        }

        const repos = rawRepos.map((repo) => ({
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
          description: repo.description,
        }));

        return reply.code(200).send({ repos });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/github/branches
  fastify.get(
    '/api/integrations/github/branches',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const { owner, repo } = request.query as { owner?: string; repo?: string };

        if (!owner || !repo) {
          return reply.code(400).send({
            error: {
              code: 'MISSING_PARAMS',
              message: 'owner and repo query parameters are required',
            },
          });
        }

        const token = await getGitHubToken(user.id);

        if (!token) {
          return reply.code(412).send({
            error: {
              code: 'GITHUB_NOT_CONNECTED',
              message: 'GitHub is not connected. Please connect GitHub first.',
            },
          });
        }

        // Get repo info for default branch
        const repoInfo = await fetchFromGitHub<{ default_branch: string }>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          token,
          request.id
        );

        // Get branches
        const rawBranches = await fetchFromGitHub<Array<{ name: string }>>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
          token,
          request.id
        );

        const branches = rawBranches.map((branch) => ({
          name: branch.name,
          isDefault: branch.name === repoInfo.default_branch,
        }));

        return reply.code(200).send({
          branches,
          defaultBranch: repoInfo.default_branch,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // ===========================================================================
  // Atlassian Remote MCP (authv2) - DCR + OAuth 2.1 via MCP SDK
  // No developer.atlassian.com app needed; the MCP server self-registers AKIS.
  // ===========================================================================

  // GET /api/integrations/atlassian/oauth/start
  fastify.get(
    '/api/integrations/atlassian/oauth/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const config = getEnv();
        const frontendUrl = appPublicUrl;

        const initiated = await getAuthorizationUrl(user.id);
        if (!initiated) {
          // User already has a valid token — short-circuit back to settings.
          return reply
            .code(302)
            .header('Location', `${frontendUrl}/settings?tab=integrations&atlassian=connected`)
            .send();
        }

        // CSRF-bind the OAuth state to this browser session. The PKCE code
        // verifier is already pinned server-side by state inside the MCP SDK
        // provider, so a stolen authorize URL + state can't be exchanged
        // without also presenting this cookie.
        reply.setCookie('atlassian_oauth_state', initiated.state, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 10 * 60,
          path: '/',
        });

        return reply.code(302).header('Location', initiated.url).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          const returnTo = encodeURIComponent('/settings?tab=integrations');
          return reply
            .code(302)
            .header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`)
            .send();
        }
        logger.error({ err }, '[integrations] Atlassian /oauth/start failed');
        return reply
          .code(302)
          .header(
            'Location',
            `${appPublicUrl}/settings?tab=integrations&atlassian=error&reason=internal_error`
          )
          .send();
      }
    }
  );

  // GET /api/integrations/atlassian/oauth/callback
  fastify.get(
    '/api/integrations/atlassian/oauth/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const {
        code,
        state: receivedState,
        error: oauthError,
      } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };
      const frontendUrl = appPublicUrl;
      const redirectErr = (reason: string) =>
        reply
          .code(302)
          .header(
            'Location',
            `${frontendUrl}/settings?tab=integrations&atlassian=error&reason=${encodeURIComponent(reason)}`
          )
          .send();

      try {
        const user = await requireAuth(request);

        if (oauthError) return redirectErr(oauthError);
        if (!code || !receivedState) return redirectErr('missing_code');

        const cookieState = request.cookies?.atlassian_oauth_state;
        if (!cookieState || cookieState !== receivedState) {
          return redirectErr('state_mismatch');
        }
        reply.clearCookie('atlassian_oauth_state', { path: '/' });

        try {
          await finishOAuth(user.id, code, receivedState);
        } catch (err) {
          logger.error({ err, userId: user.id }, '[integrations] OAuth completion failed');
          return redirectErr('token_exchange_failed');
        }

        // cloudId / siteUrl are resolved lazily on first JiraMCPService usage
        // (NOT here). Atlassian's MCP server returns 401 if we call any tool
        // within the first ~few seconds after token issuance — the new bearer
        // hasn't propagated through their backend yet. The lazy path runs at
        // pipeline-start time, by which point propagation is complete.

        return reply
          .code(302)
          .header('Location', `${frontendUrl}/settings?tab=integrations&atlassian=connected`)
          .send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          const returnTo = encodeURIComponent('/settings?tab=integrations');
          return reply
            .code(302)
            .header('Location', `${frontendUrl}/login?returnTo=${returnTo}`)
            .send();
        }
        logger.error({ err }, '[integrations] Atlassian /oauth/callback failed');
        return redirectErr('internal_error');
      }
    }
  );

  // GET /api/integrations/atlassian/status
  fastify.get(
    '/api/integrations/atlassian/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const status = await getConnectionStatus(user.id);
        // Compat shape: existing UI reads { connected, siteUrl, cloudId,
        // jiraAvailable, confluenceAvailable }. With authv2 the same OAuth
        // grant covers both products, so we report both as available iff
        // connected. `configured` always true (DCR removes the env-var gate).
        return reply.code(200).send({
          ...status,
          configured: true,
          jiraAvailable: status.connected,
          confluenceAvailable: status.connected,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply
            .code(401)
            .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        logger.error({ err }, '[integrations] Atlassian status check failed');
        return reply.code(200).send({
          connected: false,
          configured: true,
          jiraAvailable: false,
          confluenceAvailable: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check Atlassian status' },
        });
      }
    }
  );

  // POST /api/integrations/atlassian/disconnect
  fastify.post(
    '/api/integrations/atlassian/disconnect',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        await deleteAtlassianTokens(user.id);
        return reply.code(200).send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply
            .code(401)
            .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/jira/projects — list projects the user can create
  // issues in. Drives the optional Jira project picker on the spec-approval
  // card. Always 200; the `status` field tells the UI which state to render:
  //   'ok'             → projects[] populated, render picker
  //   'not_connected'  → user hasn't done Atlassian OAuth yet, hide picker
  //   'jira_not_installed' → site has no Jira product (Atlassian returns 404
  //                          on the project search path). Show "Jira'yı sitene
  //                          ekle" guidance.
  //   'jira_not_granted'   → token doesn't cover Jira on this site (403,
  //                          typical when user OAuth'd before installing Jira).
  //                          Tell user to disconnect + reconnect.
  //   'no_projects'    → connected + grant ok but the site has zero projects.
  //                      Show "Jira'da bir proje aç" guidance.
  //   'error'          → unexpected; UI shows generic error.
  fastify.get(
    '/api/integrations/jira/projects',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const jira = await JiraMCPService.fromOAuth(user.id);
        if (!jira) {
          return reply.code(200).send({ status: 'not_connected', projects: [] });
        }
        try {
          const projects = await jira.listProjects();
          if (projects.length === 0) {
            return reply.code(200).send({ status: 'no_projects', projects: [] });
          }
          return reply.code(200).send({ status: 'ok', projects });
        } catch (toolErr) {
          const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          if (/404|not\s+found/i.test(msg)) {
            return reply.code(200).send({ status: 'jira_not_installed', projects: [] });
          }
          if (/403|forbidden|not installed on this instance/i.test(msg)) {
            return reply.code(200).send({ status: 'jira_not_granted', projects: [] });
          }
          logger.warn({ err: toolErr }, '[integrations] Jira projects: unknown tool error');
          return reply.code(200).send({ status: 'error', projects: [] });
        } finally {
          await jira.close();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply
            .code(401)
            .send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        logger.warn({ err }, '[integrations] Jira projects listing failed');
        return reply.code(200).send({ status: 'error', projects: [] });
      }
    }
  );

  // ===========================================================================
  // Jira & Confluence Integration Endpoints (Legacy API Token - Soft Deprecated)
  // OAuth is now the primary method; API tokens kept for advanced/manual use
  // ===========================================================================

  // GET /api/integrations - List all integration statuses
  fastify.get('/api/integrations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = await requireAuth(request);

      // Get GitHub status - isolated error handling
      let githubStatus: {
        connected: boolean;
        login?: string;
        error?: { code: string; message: string };
      } = { connected: false };
      try {
        const token = await getGitHubToken(user.id);
        if (token) {
          try {
            const githubUser = await fetchFromGitHub<{ login: string }>('/user', token, request.id);
            githubStatus = { connected: true, login: githubUser.login };
          } catch {
            githubStatus = { connected: false };
          }
        }
      } catch (ghErr) {
        logger.error(`[integrations] GitHub status check failed: ${ghErr}`);
        githubStatus = {
          connected: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check GitHub status' },
        };
      }

      // Get Atlassian OAuth status - isolated error handling
      let atlassianStatus: {
        connected: boolean;
        siteUrl?: string;
        cloudId?: string;
        jiraAvailable: boolean;
        confluenceAvailable: boolean;
        error?: { code: string; message: string };
      } = {
        connected: false,
        jiraAvailable: false,
        confluenceAvailable: false,
      };
      try {
        // With MCP authv2 a single OAuth grant covers Jira + Confluence;
        // available-flags collapse to the connected flag.
        const atlassianOAuthStatus = await getConnectionStatus(user.id);
        atlassianStatus = {
          connected: atlassianOAuthStatus.connected,
          siteUrl: atlassianOAuthStatus.siteUrl,
          cloudId: atlassianOAuthStatus.cloudId,
          jiraAvailable: atlassianOAuthStatus.connected,
          confluenceAvailable: atlassianOAuthStatus.connected,
        };
      } catch (atlErr) {
        logger.error(`[integrations] Atlassian status check failed: ${atlErr}`);
        atlassianStatus = {
          connected: false,
          jiraAvailable: false,
          confluenceAvailable: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check Atlassian status' },
        };
      }

      // With MCP authv2 the single Atlassian OAuth grant covers both Jira and
      // Confluence; per-product status mirrors the aggregator. viaOAuth=true
      // is always implied (PAT path was removed in Phase 1 of MCP migration).
      type ProductStatus = {
        connected: boolean;
        siteUrl?: string;
        viaOAuth?: boolean;
        error?: { code: string; message: string };
      };
      const jiraStatus: ProductStatus = atlassianStatus.connected
        ? { connected: true, siteUrl: atlassianStatus.siteUrl, viaOAuth: true }
        : { connected: false };
      const confluenceStatus: ProductStatus = atlassianStatus.connected
        ? { connected: true, siteUrl: atlassianStatus.siteUrl, viaOAuth: true }
        : { connected: false };

      return reply.code(200).send({
        github: githubStatus,
        atlassian: atlassianStatus,
        jira: jiraStatus,
        confluence: confluenceStatus,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'UNAUTHORIZED') {
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }
      // Even if something catastrophic happens, return a degraded response
      logger.error(`[integrations] All status check failed: ${err}`);
      return reply.code(200).send({
        github: {
          connected: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' },
        },
        atlassian: {
          connected: false,
          jiraAvailable: false,
          confluenceAvailable: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' },
        },
        jira: {
          connected: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' },
        },
        confluence: {
          connected: false,
          error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' },
        },
      });
    }
  });
}
