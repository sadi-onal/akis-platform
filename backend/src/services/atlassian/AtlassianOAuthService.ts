/**
 * AtlassianOAuthService - OAuth 2.0 (3LO) token management for Atlassian
 * 
 * Features:
 * - Token exchange (authorization code -> access/refresh tokens)
 * - Rotating refresh token support (new refresh token on each refresh)
 * - Encrypted token storage using AES-256-GCM
 * - Automatic token refresh when expired
 * - Accessible resources discovery (cloudId, siteUrl)
 */

import { db } from '../../db/client.js';
import { oauthAccounts } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getEnv } from '../../config/env.js';
import { encryptSecret, decryptSecret } from '../../utils/crypto.js';
import { logger } from '../../lib/logger.js';

// =============================================================================
// Types
// =============================================================================

export interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface AtlassianAccessibleResource {
  id: string;      // cloudId
  url: string;     // site URL (e.g., https://your-domain.atlassian.net)
  name: string;    // site name
  scopes: string[];
  avatarUrl?: string;
}

export interface AtlassianOAuthStatus {
  connected: boolean;
  siteUrl?: string;
  cloudId?: string;
  scopes?: string;
  tokenExpiresAt?: Date | null;
  refreshTokenRotatedAt?: Date | null;
  jiraAvailable: boolean;
  confluenceAvailable: boolean;
}

export interface StoredAtlassianOAuth {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  cloudId: string | null;
  siteUrl: string | null;
  scopes: string | null;
}

// =============================================================================
// Constants
// =============================================================================

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// Buffer time before expiry to refresh (5 minutes)
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// =============================================================================
// AtlassianOAuthService
// =============================================================================

export class AtlassianOAuthService {
  private encryptionScope(userId: string): string {
    return `atlassian:${userId}`;
  }

  /**
   * Build the Atlassian OAuth authorization URL
   */
  buildAuthorizationUrl(state: string): string {
    const env = getEnv();
    
    if (!env.ATLASSIAN_OAUTH_CLIENT_ID) {
      throw new Error('ATLASSIAN_OAUTH_CLIENT_ID is not configured');
    }

    const scopes = [
      'offline_access',  // CRITICAL: Required for refresh tokens
      'read:me',
      'read:account',
      'read:jira-work',
      'read:jira-user',
      'read:confluence-content.all',
      'read:confluence-user',
    ].join(' ');

    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: env.ATLASSIAN_OAUTH_CLIENT_ID,
      scope: scopes,
      redirect_uri: env.ATLASSIAN_OAUTH_CALLBACK_URL,
      state,
      response_type: 'code',
      prompt: 'consent',
    });

    return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<AtlassianTokenResponse> {
    const env = getEnv();

    if (!env.ATLASSIAN_OAUTH_CLIENT_ID || !env.ATLASSIAN_OAUTH_CLIENT_SECRET) {
      throw new Error('Atlassian OAuth is not configured');
    }

    const response = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: env.ATLASSIAN_OAUTH_CLIENT_ID,
        client_secret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: env.ATLASSIAN_OAUTH_CALLBACK_URL,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<AtlassianTokenResponse>;
  }

  /**
   * Get accessible resources (sites) for the user
   */
  async getAccessibleResources(accessToken: string): Promise<AtlassianAccessibleResource[]> {
    const response = await fetch(ATLASSIAN_RESOURCES_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to get accessible resources: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<AtlassianAccessibleResource[]>;
  }

  /**
   * Store OAuth tokens for a user (encrypted)
   */
  async storeTokens(
    userId: string,
    tokens: AtlassianTokenResponse,
    resource: AtlassianAccessibleResource
  ): Promise<void> {
    const scope = this.encryptionScope(userId);
    
    // Encrypt tokens
    const encryptedAccess = encryptSecret(tokens.access_token, scope);
    const encryptedRefresh = tokens.refresh_token 
      ? encryptSecret(tokens.refresh_token, scope)
      : null;

    // Calculate expiry time
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Build encrypted token strings (store as JSON for encryption metadata)
    const accessTokenEncrypted = JSON.stringify(encryptedAccess);
    const refreshTokenEncrypted = encryptedRefresh ? JSON.stringify(encryptedRefresh) : null;

    // Check if record exists
    const existing = await db.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.provider, 'atlassian')
      ),
    });

    const now = new Date();

    if (existing) {
      await db
        .update(oauthAccounts)
        .set({
          accessToken: accessTokenEncrypted,
          refreshToken: refreshTokenEncrypted,
          tokenExpiresAt,
          cloudId: resource.id,
          siteUrl: resource.url,
          scopes: tokens.scope,
          refreshTokenRotatedAt: now,
          providerAccountId: resource.id, // Use cloudId as provider account ID
          updatedAt: now,
        })
        .where(eq(oauthAccounts.id, existing.id));
    } else {
      await db.insert(oauthAccounts).values({
        userId,
        provider: 'atlassian',
        providerAccountId: resource.id,
        accessToken: accessTokenEncrypted,
        refreshToken: refreshTokenEncrypted,
        tokenExpiresAt,
        cloudId: resource.id,
        siteUrl: resource.url,
        scopes: tokens.scope,
        refreshTokenRotatedAt: now,
      });
    }
  }

  /**
   * Get stored OAuth data for a user
   */
  async getStoredOAuth(userId: string): Promise<StoredAtlassianOAuth | null> {
    const record = await db.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.provider, 'atlassian')
      ),
    });

    if (!record || !record.accessToken) {
      return null;
    }

    const scope = this.encryptionScope(userId);

    try {
      // Decrypt access token
      const encryptedAccess = JSON.parse(record.accessToken);
      const accessToken = decryptSecret(encryptedAccess, scope);

      // Decrypt refresh token if present
      let refreshToken: string | null = null;
      if (record.refreshToken) {
        const encryptedRefresh = JSON.parse(record.refreshToken);
        refreshToken = decryptSecret(encryptedRefresh, scope);
      }

      return {
        accessToken,
        refreshToken,
        tokenExpiresAt: record.tokenExpiresAt,
        cloudId: record.cloudId,
        siteUrl: record.siteUrl,
        scopes: record.scopes,
      };
    } catch (error) {
      logger.error(`[AtlassianOAuthService] Failed to decrypt tokens: ${error}`);
      return null;
    }
  }

  /**
   * Refresh access token using refresh token (handles rotating refresh tokens)
   */
  async refreshAccessToken(userId: string): Promise<string | null> {
    const stored = await this.getStoredOAuth(userId);
    
    if (!stored || !stored.refreshToken) {
      return null;
    }

    const env = getEnv();

    if (!env.ATLASSIAN_OAUTH_CLIENT_ID || !env.ATLASSIAN_OAUTH_CLIENT_SECRET) {
      return null;
    }

    try {
      const response = await fetch(ATLASSIAN_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: env.ATLASSIAN_OAUTH_CLIENT_ID,
          client_secret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
          refresh_token: stored.refreshToken,
        }),
      });

      if (!response.ok) {
        logger.error(`[AtlassianOAuthService] Token refresh failed: ${response.status}`);
        // If refresh fails, clear tokens (user needs to re-authenticate)
        await this.deleteOAuth(userId);
        return null;
      }

      const tokens = await response.json() as AtlassianTokenResponse;
      const scope = this.encryptionScope(userId);

      // Encrypt new tokens (IMPORTANT: Atlassian uses rotating refresh tokens)
      const encryptedAccess = encryptSecret(tokens.access_token, scope);
      const encryptedRefresh = tokens.refresh_token
        ? encryptSecret(tokens.refresh_token, scope)
        : null;

      const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      const now = new Date();

      // Update stored tokens
      await db
        .update(oauthAccounts)
        .set({
          accessToken: JSON.stringify(encryptedAccess),
          refreshToken: encryptedRefresh ? JSON.stringify(encryptedRefresh) : null,
          tokenExpiresAt,
          refreshTokenRotatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(oauthAccounts.userId, userId),
            eq(oauthAccounts.provider, 'atlassian')
          )
        );

      return tokens.access_token;
    } catch (error) {
      logger.error(`[AtlassianOAuthService] Token refresh error: ${error}`);
      return null;
    }
  }

  /**
   * Get a valid access token (refreshes if needed)
   */
  async getValidToken(userId: string): Promise<string | null> {
    const stored = await this.getStoredOAuth(userId);
    
    if (!stored) {
      return null;
    }

    // Check if token is expired or about to expire
    const now = Date.now();
    const expiresAt = stored.tokenExpiresAt?.getTime() ?? 0;
    const isExpired = expiresAt - TOKEN_REFRESH_BUFFER_MS < now;

    if (isExpired && stored.refreshToken) {
      // Token expired, try to refresh
      return this.refreshAccessToken(userId);
    }

    return stored.accessToken;
  }

  /**
   * Get OAuth status for a user
   */
  async getStatus(userId: string): Promise<AtlassianOAuthStatus> {
    const record = await db.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.provider, 'atlassian')
      ),
    });

    if (!record) {
      return {
        connected: false,
        jiraAvailable: false,
        confluenceAvailable: false,
      };
    }

    // Check if we have a valid token (can decrypt)
    const stored = await this.getStoredOAuth(userId);
    const hasValidToken = stored !== null;

    // Parse scopes to determine available products
    const scopes = record.scopes || '';
    const jiraAvailable = scopes.includes('read:jira');
    const confluenceAvailable = scopes.includes('read:confluence');

    return {
      connected: hasValidToken,
      siteUrl: record.siteUrl || undefined,
      cloudId: record.cloudId || undefined,
      scopes: record.scopes || undefined,
      tokenExpiresAt: record.tokenExpiresAt,
      refreshTokenRotatedAt: record.refreshTokenRotatedAt,
      jiraAvailable,
      confluenceAvailable,
    };
  }

  /**
   * Delete OAuth record for a user
   */
  async deleteOAuth(userId: string): Promise<void> {
    await db
      .delete(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.userId, userId),
          eq(oauthAccounts.provider, 'atlassian')
        )
      );
  }

  /**
   * Check if Atlassian OAuth is configured
   */
  isConfigured(): boolean {
    const env = getEnv();
    return !!(env.ATLASSIAN_OAUTH_CLIENT_ID && env.ATLASSIAN_OAUTH_CLIENT_SECRET);
  }
}

// Export singleton instance
export const atlassianOAuthService = new AtlassianOAuthService();
