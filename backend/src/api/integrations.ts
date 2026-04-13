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
import { oauthAccounts, integrationCredentials } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER } from '../core/orchestrator/AgentOrchestrator.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { atlassianOAuthService } from '../services/atlassian/index.js';
import { McpGateway } from '../services/mcp/McpGateway.js';
import {
  oauthTokenCrypto,
  OAuthTokenCryptoError,
} from '../services/auth/OAuthTokenCrypto.js';
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

// Helper to get user's GitHub OAuth token
async function getGitHubToken(userId: string): Promise<string | null> {
  const githubOAuth = await db.query.oauthAccounts.findFirst({
    where: and(
      eq(oauthAccounts.userId, userId),
      eq(oauthAccounts.provider, 'github')
    ),
  });

  const rawToken = githubOAuth?.accessToken || null;
  if (rawToken && rawToken !== DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER) {
    try {
      return oauthTokenCrypto.decryptForUse({
        userId,
        provider: 'github',
        rawToken,
        kind: 'access',
      });
    } catch (error) {
      logger.warn(`[integrations] Failed to decrypt stored GitHub OAuth token: ${error}`);
      return null;
    }
  }

  if (rawToken === DEV_GITHUB_BOOTSTRAP_TOKEN_PLACEHOLDER && process.env.SCRIBE_DEV_GITHUB_BOOTSTRAP === 'true') {
    const env = getEnv();
    return env.SCRIBE_DEV_BOOTSTRAP_GITHUB_TOKEN || env.GITHUB_TOKEN || null;
  }

  return rawToken;
}

export async function integrationsRoutes(fastify: FastifyInstance) {
  // Resolve frontend URL for redirects (APP_PUBLIC_URL is optional, fallback to FRONTEND_URL)
  const appPublicUrl = getEnv().APP_PUBLIC_URL || getEnv().FRONTEND_URL;

  // GET /api/integrations/github/oauth/start - Start OAuth flow
  fastify.get(
    '/api/integrations/github/oauth/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Require AKIS session
        await requireAuth(request);
        const config = getEnv();

        // Check OAuth configuration
        if (!config.GITHUB_OAUTH_CLIENT_ID || !config.GITHUB_OAUTH_CLIENT_SECRET) {
          return reply.code(501).send({
            error: {
              code: 'GITHUB_OAUTH_NOT_CONFIGURED',
              message: 'GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET env vars.',
            },
          });
        }

        if (!config.GITHUB_OAUTH_CALLBACK_URL) {
          return reply.code(501).send({
            error: {
              code: 'GITHUB_OAUTH_NOT_CONFIGURED',
              message: 'GITHUB_OAUTH_CALLBACK_URL is not configured.',
            },
          });
        }

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
          const returnTo = encodeURIComponent('/dashboard/settings?tab=github');
          return reply.code(302).header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`).send();
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
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=missing_code`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Validate state (CSRF protection)
        const storedState = request.cookies?.github_oauth_state;
        if (!storedState || storedState !== receivedState) {
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=state_mismatch`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Clear state cookie
        reply.clearCookie('github_oauth_state', { path: '/' });

        // Exchange code for access token (via gateway boundary)
        // redirect_uri must match what was sent in the authorization request
        const tokenExchangeRedirectUri = `${config.FRONTEND_URL}/auth/oauth/github/callback`;
        const tokenData = await mcpGateway.exchangeGitHubOAuthCode(
          {
            code,
            clientId: config.GITHUB_OAUTH_CLIENT_ID!,
            clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET!,
            redirectUri: tokenExchangeRedirectUri,
          },
          request.id
        ).catch(() => null);

        if (!tokenData) {
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=token_exchange_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }
        
        if (tokenData.error || !tokenData.access_token) {
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=token_missing`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        const accessToken = tokenData.access_token;
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
            const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=encryption_key_missing`;
            return reply.code(302).header('Location', errorUrl).send();
          }

          logger.error(`[integrations] Failed to encrypt GitHub OAuth token: ${error}`);
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=token_storage_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Fetch GitHub user info (via gateway boundary)
        const githubUser = await mcpGateway.fetchGitHubUser(accessToken, request.id).catch(() => null);
        if (!githubUser) {
          const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=user_fetch_failed`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Store/update in database
        const existingOAuth = await db.query.oauthAccounts.findFirst({
          where: and(
            eq(oauthAccounts.userId, user.id),
            eq(oauthAccounts.provider, 'github')
          ),
        });

        // Tokens are encrypted via OAuthTokenCrypto.encryptForStorage() above (AES-256-GCM)
        if (existingOAuth) {
          await db
            .update(oauthAccounts)
            .set({
              accessToken: encryptedAccessToken,
              providerAccountId: githubUser.id.toString(),
              updatedAt: new Date(),
            })
            .where(eq(oauthAccounts.id, existingOAuth.id));
        } else {
          await db.insert(oauthAccounts).values({
            userId: user.id,
            provider: 'github',
            providerAccountId: githubUser.id.toString(),
            accessToken: encryptedAccessToken,
          });
        }

        // Redirect back to integrations with success
        const successUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=connected`;
        return reply.code(302).header('Location', successUrl).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // Session lost during callback - redirect to login
          const returnTo = encodeURIComponent('/dashboard/settings?tab=github');
          return reply.code(302).header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`).send();
        }
        
        // Unexpected error
        const errorUrl = `${appPublicUrl}/dashboard/settings?tab=github&github=error&reason=internal_error`;
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
        const token = await getGitHubToken(user.id);

        if (!token) {
          return reply.code(200).send({
            connected: false,
          });
        }

        try {
          // Verify token works by fetching user info
          const githubUser = await fetchFromGitHub<{ login: string; avatar_url: string; created_at: string }>(
            '/user',
            token,
            request.id
          );

          return reply.code(200).send({
            connected: true,
            login: githubUser.login,
            avatarUrl: githubUser.avatar_url,
          });
        } catch (_err) {
          // Token exists but is invalid/expired
          return reply.code(200).send({
            connected: false,
            error: 'Token invalid or expired',
          });
        }
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

        // Delete OAuth account for GitHub
        await db
          .delete(oauthAccounts)
          .where(
            and(
              eq(oauthAccounts.userId, user.id),
              eq(oauthAccounts.provider, 'github')
            )
          );

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
          rawRepos = await fetchFromGitHub('/user/repos?per_page=100&sort=updated', token, request.id);
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
  // Atlassian OAuth 2.0 (3LO) - Single OAuth for Jira + Confluence
  // ===========================================================================

  // GET /api/integrations/atlassian/oauth/start - Start Atlassian OAuth flow
  fastify.get(
    '/api/integrations/atlassian/oauth/start',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Require AKIS session
        await requireAuth(request);
        const config = getEnv();

        // Check if Atlassian OAuth is configured
        if (!atlassianOAuthService.isConfigured()) {
          return reply.code(501).send({
            error: {
              code: 'ATLASSIAN_OAUTH_NOT_CONFIGURED',
              message: 'Atlassian OAuth is not configured. Set ATLASSIAN_OAUTH_CLIENT_ID and ATLASSIAN_OAUTH_CLIENT_SECRET env vars.',
            },
          });
        }

        // Generate CSRF state token
        const state = randomBytes(32).toString('hex');

        // Store state in httpOnly cookie (10 min TTL)
        reply.setCookie('atlassian_oauth_state', state, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 10 * 60, // 10 minutes
          path: '/',
        });

        // Build Atlassian authorization URL
        const authUrl = atlassianOAuthService.buildAuthorizationUrl(state);

        // Redirect to Atlassian
        return reply.code(302).header('Location', authUrl).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // User not logged in - redirect to login with returnTo
          const _config = getEnv();
          const returnTo = encodeURIComponent('/dashboard/settings?tab=github');
          return reply.code(302).header('Location', `${appPublicUrl}/login?returnTo=${returnTo}`).send();
        }
        throw err;
      }
    }
  );

  // GET /api/integrations/atlassian/oauth/callback - CANONICAL callback from Atlassian
  fastify.get(
    '/api/integrations/atlassian/oauth/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code, state: receivedState, error: oauthError } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };
      const _config = getEnv();
      const frontendUrl = appPublicUrl;

      try {
        // Verify we have an AKIS session
        const user = await requireAuth(request);

        // Handle OAuth error from Atlassian
        if (oauthError) {
          const errorUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=error&reason=${encodeURIComponent(oauthError)}`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Validate code parameter
        if (!code) {
          const errorUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=error&reason=missing_code`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Validate state (CSRF protection)
        const storedState = request.cookies?.atlassian_oauth_state;
        if (!storedState || storedState !== receivedState) {
          const errorUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=error&reason=state_mismatch`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Clear state cookie
        reply.clearCookie('atlassian_oauth_state', { path: '/' });

        // Exchange code for tokens
        const tokens = await atlassianOAuthService.exchangeCodeForTokens(code);

        // Get accessible resources (sites)
        const resources = await atlassianOAuthService.getAccessibleResources(tokens.access_token);

        if (resources.length === 0) {
          const errorUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=error&reason=no_accessible_resources`;
          return reply.code(302).header('Location', errorUrl).send();
        }

        // Use first accessible resource
        const primaryResource = resources[0];

        // Store tokens (encrypted)
        await atlassianOAuthService.storeTokens(user.id, tokens, primaryResource);

        // Redirect back to integrations with success
        const successUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=connected`;
        return reply.code(302).header('Location', successUrl).send();
      } catch (err: unknown) {
        logger.error(`[integrations] Atlassian OAuth callback error: ${err}`);
        
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          // Session lost during callback - redirect to login
          const returnTo = encodeURIComponent('/dashboard/settings?tab=github');
          return reply.code(302).header('Location', `${frontendUrl}/login?returnTo=${returnTo}`).send();
        }

        // Unexpected error
        const errorUrl = `${frontendUrl}/dashboard/settings?tab=github&atlassian=error&reason=internal_error`;
        return reply.code(302).header('Location', errorUrl).send();
      }
    }
  );

  // GET /api/integrations/atlassian/status - Get Atlassian OAuth status
  fastify.get(
    '/api/integrations/atlassian/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // Check if OAuth is configured
        if (!atlassianOAuthService.isConfigured()) {
          return reply.code(200).send({
            connected: false,
            configured: false,
            jiraAvailable: false,
            confluenceAvailable: false,
          });
        }

        const status = await atlassianOAuthService.getStatus(user.id);

        return reply.code(200).send({
          ...status,
          configured: true,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        // Graceful degradation - never 500 on status check
        logger.error(`[integrations] Atlassian status check failed: ${err}`);
        return reply.code(200).send({
          connected: false,
          configured: atlassianOAuthService.isConfigured(),
          jiraAvailable: false,
          confluenceAvailable: false,
          error: {
            code: 'STATUS_CHECK_FAILED',
            message: 'Unable to check Atlassian connection status. Please try again later.',
          },
        });
      }
    }
  );

  // POST /api/integrations/atlassian/disconnect - Disconnect Atlassian OAuth
  fastify.post(
    '/api/integrations/atlassian/disconnect',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        await atlassianOAuthService.deleteOAuth(user.id);

        return reply.code(200).send({ ok: true });
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
  // Jira & Confluence Integration Endpoints (Legacy API Token - Soft Deprecated)
  // OAuth is now the primary method; API tokens kept for advanced/manual use
  // ===========================================================================

  // GET /api/integrations - List all integration statuses
  fastify.get(
    '/api/integrations',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // Get GitHub status - isolated error handling
        let githubStatus: { connected: boolean; login?: string; error?: { code: string; message: string } } = { connected: false };
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
            error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check GitHub status' }
          };
        }

        // Get Atlassian OAuth status - isolated error handling
        let atlassianStatus: { connected: boolean; siteUrl?: string; cloudId?: string; jiraAvailable: boolean; confluenceAvailable: boolean; error?: { code: string; message: string } } = { 
          connected: false, 
          jiraAvailable: false, 
          confluenceAvailable: false 
        };
        try {
          const atlassianOAuthStatus = await atlassianOAuthService.getStatus(user.id);
          atlassianStatus = {
            connected: atlassianOAuthStatus.connected,
            siteUrl: atlassianOAuthStatus.siteUrl,
            cloudId: atlassianOAuthStatus.cloudId,
            jiraAvailable: atlassianOAuthStatus.jiraAvailable,
            confluenceAvailable: atlassianOAuthStatus.confluenceAvailable,
          };
        } catch (atlErr) {
          logger.error(`[integrations] Atlassian status check failed: ${atlErr}`);
          atlassianStatus = {
            connected: false,
            jiraAvailable: false,
            confluenceAvailable: false,
            error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check Atlassian status' }
          };
        }

        // Get Jira status - OAuth first, then legacy API token
        let jiraStatus: { connected: boolean; siteUrl?: string; userEmail?: string; lastValidatedAt?: Date | null; viaOAuth?: boolean; error?: { code: string; message: string } } = { connected: false };
        try {
          // Check OAuth first
          if (atlassianStatus.connected && atlassianStatus.jiraAvailable) {
            jiraStatus = {
              connected: true,
              siteUrl: atlassianStatus.siteUrl,
              viaOAuth: true,
            };
          } else {
            // Fall back to legacy API token
            const jiraCred = await db.query.integrationCredentials.findFirst({
              where: and(
                eq(integrationCredentials.userId, user.id),
                eq(integrationCredentials.provider, 'jira')
              ),
            });
            if (jiraCred) {
              jiraStatus = {
                connected: jiraCred.isValid,
                siteUrl: jiraCred.siteUrl,
                userEmail: jiraCred.userEmail,
                lastValidatedAt: jiraCred.lastValidatedAt,
                viaOAuth: false,
              };
            }
          }
        } catch (jiraErr) {
          logger.error(`[integrations] Jira status check failed: ${jiraErr}`);
          jiraStatus = { 
            connected: false, 
            error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check Jira status' }
          };
        }

        // Get Confluence status - OAuth first, then legacy API token
        let confluenceStatus: { connected: boolean; siteUrl?: string; userEmail?: string; lastValidatedAt?: Date | null; viaOAuth?: boolean; error?: { code: string; message: string } } = { connected: false };
        try {
          // Check OAuth first
          if (atlassianStatus.connected && atlassianStatus.confluenceAvailable) {
            confluenceStatus = {
              connected: true,
              siteUrl: atlassianStatus.siteUrl,
              viaOAuth: true,
            };
          } else {
            // Fall back to legacy API token
            const confluenceCred = await db.query.integrationCredentials.findFirst({
              where: and(
                eq(integrationCredentials.userId, user.id),
                eq(integrationCredentials.provider, 'confluence')
              ),
            });
            if (confluenceCred) {
              confluenceStatus = {
                connected: confluenceCred.isValid,
                siteUrl: confluenceCred.siteUrl,
                userEmail: confluenceCred.userEmail,
                lastValidatedAt: confluenceCred.lastValidatedAt,
                viaOAuth: false,
              };
            }
          }
        } catch (confErr) {
          logger.error(`[integrations] Confluence status check failed: ${confErr}`);
          confluenceStatus = { 
            connected: false, 
            error: { code: 'STATUS_CHECK_FAILED', message: 'Unable to check Confluence status' }
          };
        }

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
          github: { connected: false, error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' } },
          atlassian: { connected: false, jiraAvailable: false, confluenceAvailable: false, error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' } },
          jira: { connected: false, error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' } },
          confluence: { connected: false, error: { code: 'STATUS_CHECK_FAILED', message: 'Service unavailable' } },
        });
      }
    }
  );

  // Helper: Test Atlassian API connection
  async function testAtlassianConnection(
    siteUrl: string,
    email: string,
    apiToken: string,
    provider: 'jira' | 'confluence',
    correlationId?: string
  ): Promise<{ success: boolean; error?: string; displayName?: string }> {
    return mcpGateway.testAtlassianConnection(siteUrl, email, apiToken, provider, correlationId);
  }

  // POST /api/integrations/jira - Connect Jira
  fastify.post(
    '/api/integrations/jira',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = request.body as { siteUrl?: string; email?: string; apiToken?: string };

        // Validate input
        if (!body.siteUrl || !body.email || !body.apiToken) {
          return reply.code(400).send({
            error: { code: 'MISSING_FIELDS', message: 'siteUrl, email, and apiToken are required' },
          });
        }

        // Normalize site URL (remove trailing slash)
        const siteUrl = body.siteUrl.replace(/\/+$/, '');

        // Test connection first
        const testResult = await testAtlassianConnection(
          siteUrl,
          body.email,
          body.apiToken,
          'jira',
          request.id
        );
        if (!testResult.success) {
          return reply.code(400).send({
            error: { code: 'CONNECTION_FAILED', message: testResult.error || 'Failed to connect to Jira' },
          });
        }

        // Encrypt the API token
        const encrypted = encryptSecret(body.apiToken, `jira:${user.id}`);
        const tokenLast4 = body.apiToken.slice(-4);

        // Check if exists, update or insert
        const existing = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'jira')
          ),
        });

        if (existing) {
          await db
            .update(integrationCredentials)
            .set({
              siteUrl,
              userEmail: body.email,
              encryptedToken: encrypted.cipherText,
              tokenIv: encrypted.iv,
              tokenTag: encrypted.authTag,
              keyVersion: encrypted.keyVersion,
              tokenLast4,
              lastValidatedAt: new Date(),
              isValid: true,
              updatedAt: new Date(),
            })
            .where(eq(integrationCredentials.id, existing.id));
        } else {
          await db.insert(integrationCredentials).values({
            userId: user.id,
            provider: 'jira',
            siteUrl,
            userEmail: body.email,
            encryptedToken: encrypted.cipherText,
            tokenIv: encrypted.iv,
            tokenTag: encrypted.authTag,
            keyVersion: encrypted.keyVersion,
            tokenLast4,
            lastValidatedAt: new Date(),
            isValid: true,
          });
        }

        return reply.code(200).send({
          success: true,
          message: 'Jira connected successfully',
          displayName: testResult.displayName,
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

  // GET /api/integrations/jira/status
  // Checks OAuth first, falls back to legacy API token
  fastify.get(
    '/api/integrations/jira/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // Check OAuth first (primary method)
        const atlassianStatus = await atlassianOAuthService.getStatus(user.id);
        if (atlassianStatus.connected && atlassianStatus.jiraAvailable) {
          return reply.code(200).send({
            connected: true,
            siteUrl: atlassianStatus.siteUrl,
            viaOAuth: true,
            scopes: atlassianStatus.scopes,
          });
        }

        // Fall back to legacy API token
        const cred = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'jira')
          ),
        });

        if (!cred) {
          return reply.code(200).send({ connected: false });
        }

        return reply.code(200).send({
          connected: cred.isValid,
          siteUrl: cred.siteUrl,
          userEmail: cred.userEmail,
          tokenLast4: cred.tokenLast4,
          lastValidatedAt: cred.lastValidatedAt,
          viaOAuth: false,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        // Graceful degradation: return disconnected status with error info
        // Never return 500 for status check endpoints
        logger.error(`[integrations] Jira status check failed: ${err}`);
        return reply.code(200).send({
          connected: false,
          error: {
            code: 'STATUS_CHECK_FAILED',
            message: 'Unable to check Jira connection status. Please try again later.',
          },
        });
      }
    }
  );

  // POST /api/integrations/jira/test - Test existing connection
  fastify.post(
    '/api/integrations/jira/test',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        const cred = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'jira')
          ),
        });

        if (!cred) {
          return reply.code(404).send({
            error: { code: 'NOT_CONNECTED', message: 'Jira is not connected' },
          });
        }

        // Decrypt token
        const apiToken = decryptSecret({
          cipherText: cred.encryptedToken,
          iv: cred.tokenIv,
          authTag: cred.tokenTag,
          keyVersion: cred.keyVersion,
        }, `jira:${user.id}`);

        // Test connection
        const testResult = await testAtlassianConnection(
          cred.siteUrl,
          cred.userEmail,
          apiToken,
          'jira',
          request.id
        );

        // Update validation status
        await db
          .update(integrationCredentials)
          .set({
            isValid: testResult.success,
            lastValidatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(integrationCredentials.id, cred.id));

        if (!testResult.success) {
          return reply.code(200).send({
            success: false,
            error: testResult.error,
          });
        }

        return reply.code(200).send({
          success: true,
          displayName: testResult.displayName,
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

  // DELETE /api/integrations/jira
  (fastify as FastifyInstance & { delete: typeof fastify.get }).delete(
    '/api/integrations/jira',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        await db
          .delete(integrationCredentials)
          .where(
            and(
              eq(integrationCredentials.userId, user.id),
              eq(integrationCredentials.provider, 'jira')
            )
          );

        return reply.code(200).send({ ok: true });
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

  // POST /api/integrations/confluence - Connect Confluence
  fastify.post(
    '/api/integrations/confluence',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);
        const body = request.body as { siteUrl?: string; email?: string; apiToken?: string };

        // Validate input
        if (!body.siteUrl || !body.email || !body.apiToken) {
          return reply.code(400).send({
            error: { code: 'MISSING_FIELDS', message: 'siteUrl, email, and apiToken are required' },
          });
        }

        // Normalize site URL (remove trailing slash)
        const siteUrl = body.siteUrl.replace(/\/+$/, '');

        // Test connection first
        const testResult = await testAtlassianConnection(
          siteUrl,
          body.email,
          body.apiToken,
          'confluence',
          request.id
        );
        if (!testResult.success) {
          return reply.code(400).send({
            error: { code: 'CONNECTION_FAILED', message: testResult.error || 'Failed to connect to Confluence' },
          });
        }

        // Encrypt the API token
        const encrypted = encryptSecret(body.apiToken, `confluence:${user.id}`);
        const tokenLast4 = body.apiToken.slice(-4);

        // Check if exists, update or insert
        const existing = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'confluence')
          ),
        });

        if (existing) {
          await db
            .update(integrationCredentials)
            .set({
              siteUrl,
              userEmail: body.email,
              encryptedToken: encrypted.cipherText,
              tokenIv: encrypted.iv,
              tokenTag: encrypted.authTag,
              keyVersion: encrypted.keyVersion,
              tokenLast4,
              lastValidatedAt: new Date(),
              isValid: true,
              updatedAt: new Date(),
            })
            .where(eq(integrationCredentials.id, existing.id));
        } else {
          await db.insert(integrationCredentials).values({
            userId: user.id,
            provider: 'confluence',
            siteUrl,
            userEmail: body.email,
            encryptedToken: encrypted.cipherText,
            tokenIv: encrypted.iv,
            tokenTag: encrypted.authTag,
            keyVersion: encrypted.keyVersion,
            tokenLast4,
            lastValidatedAt: new Date(),
            isValid: true,
          });
        }

        return reply.code(200).send({
          success: true,
          message: 'Confluence connected successfully',
          displayName: testResult.displayName,
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

  // GET /api/integrations/confluence/status
  // Checks OAuth first, falls back to legacy API token
  fastify.get(
    '/api/integrations/confluence/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // Check OAuth first (primary method)
        const atlassianStatus = await atlassianOAuthService.getStatus(user.id);
        if (atlassianStatus.connected && atlassianStatus.confluenceAvailable) {
          return reply.code(200).send({
            connected: true,
            siteUrl: atlassianStatus.siteUrl,
            viaOAuth: true,
            scopes: atlassianStatus.scopes,
          });
        }

        // Fall back to legacy API token
        const cred = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'confluence')
          ),
        });

        if (!cred) {
          return reply.code(200).send({ connected: false });
        }

        return reply.code(200).send({
          connected: cred.isValid,
          siteUrl: cred.siteUrl,
          userEmail: cred.userEmail,
          tokenLast4: cred.tokenLast4,
          lastValidatedAt: cred.lastValidatedAt,
          viaOAuth: false,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        // Graceful degradation: return disconnected status with error info
        // Never return 500 for status check endpoints
        logger.error(`[integrations] Confluence status check failed: ${err}`);
        return reply.code(200).send({
          connected: false,
          error: {
            code: 'STATUS_CHECK_FAILED',
            message: 'Unable to check Confluence connection status. Please try again later.',
          },
        });
      }
    }
  );

  // POST /api/integrations/confluence/test - Test existing connection
  fastify.post(
    '/api/integrations/confluence/test',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        const cred = await db.query.integrationCredentials.findFirst({
          where: and(
            eq(integrationCredentials.userId, user.id),
            eq(integrationCredentials.provider, 'confluence')
          ),
        });

        if (!cred) {
          return reply.code(404).send({
            error: { code: 'NOT_CONNECTED', message: 'Confluence is not connected' },
          });
        }

        // Decrypt token
        const apiToken = decryptSecret({
          cipherText: cred.encryptedToken,
          iv: cred.tokenIv,
          authTag: cred.tokenTag,
          keyVersion: cred.keyVersion,
        }, `confluence:${user.id}`);

        // Test connection
        const testResult = await testAtlassianConnection(
          cred.siteUrl,
          cred.userEmail,
          apiToken,
          'confluence',
          request.id
        );

        // Update validation status
        await db
          .update(integrationCredentials)
          .set({
            isValid: testResult.success,
            lastValidatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(integrationCredentials.id, cred.id));

        if (!testResult.success) {
          return reply.code(200).send({
            success: false,
            error: testResult.error,
          });
        }

        return reply.code(200).send({
          success: true,
          displayName: testResult.displayName,
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

  // DELETE /api/integrations/confluence
  (fastify as FastifyInstance & { delete: typeof fastify.get }).delete(
    '/api/integrations/confluence',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        await db
          .delete(integrationCredentials)
          .where(
            and(
              eq(integrationCredentials.userId, user.id),
              eq(integrationCredentials.provider, 'confluence')
            )
          );

        return reply.code(200).send({ ok: true });
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
}
