/**
 * AtlassianMcpClient — connects AKIS to Atlassian's remote MCP server
 * (https://mcp.atlassian.com/v1/mcp/authv2) using the official MCP SDK with
 * OAuth 2.1 + RFC 7591 Dynamic Client Registration.
 *
 * Layering:
 *   - DbBackedTokenStore: per-user token persistence in `oauth_accounts`
 *     (encrypted via AES-256-GCM, scope = "atlassian:<userId>"). DCR client
 *     info lives in `mcp_oauth_clients` (shared across all users — DCR
 *     registers the *AKIS instance*, not individual end-users).
 *   - AtlassianOAuthProvider: implements MCP SDK's `OAuthClientProvider`,
 *     wires the store + an ephemeral in-memory PKCE codeVerifier map keyed
 *     by OAuth state.
 *   - getAuthorizationUrl / finishOAuth / connect: helpers consumed by the
 *     HTTP route handlers.
 *
 * Why a per-userId provider instance: MCP SDK's OAuthClientProvider abstracts
 * "current session" — for a single-process multi-tenant backend, that session
 * is the AKIS user. We construct a fresh provider per route handler / per
 * pipeline call, but all three storage backends (oauth_accounts, mcp_oauth_clients,
 * the codeVerifier map) are process-shared so concurrent users don't collide.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { oauthAccounts, mcpOauthClients } from '../../db/schema.js';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../../utils/crypto.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

// =============================================================================
// Constants
// =============================================================================

export const ATLASSIAN_MCP_SERVER_URL = 'https://mcp.atlassian.com/v1/mcp/authv2';

const CLIENT_NAME = 'AKIS Platform';

// PKCE code verifiers must outlive the redirect (browser round-trip) but not
// stay around forever. Atlassian's authorize URL is single-use within minutes.
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PKCE_SWEEP_INTERVAL_MS = 60 * 1000;

// =============================================================================
// PKCE state — process-shared, in-memory.
// =============================================================================
// codeVerifier MUST be retrievable in the OAuth callback handler, which is a
// different HTTP request than /oauth/start. Both run in the same Node process
// so a Map is enough. If the pod restarts mid-flow the user just clicks
// Connect again — 10-min TTL means stale entries self-evict.
type PkceEntry = { codeVerifier: string; userId: string; createdAt: number };
const pkceStore = new Map<string, PkceEntry>();

let sweepTimer: NodeJS.Timeout | undefined;
function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - PKCE_TTL_MS;
    for (const [state, entry] of pkceStore) {
      if (entry.createdAt < cutoff) pkceStore.delete(state);
    }
  }, PKCE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

// =============================================================================
// Token storage helpers (DB-backed, encrypted)
// =============================================================================

const tokenScope = (userId: string): string => `atlassian:${userId}`;

async function loadUserTokens(userId: string): Promise<OAuthTokens | undefined> {
  const row = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')),
  });
  if (!row?.accessToken) return undefined;

  const scope = tokenScope(userId);
  try {
    const access = decryptSecret(JSON.parse(row.accessToken) as EncryptedSecret, scope);
    const refresh = row.refreshToken
      ? decryptSecret(JSON.parse(row.refreshToken) as EncryptedSecret, scope)
      : undefined;
    const expiresIn = row.tokenExpiresAt
      ? Math.max(0, Math.floor((row.tokenExpiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: row.scopes ?? undefined,
    };
  } catch (err) {
    logger.error({ err, userId }, '[AtlassianMcpClient] token decrypt failed');
    return undefined;
  }
}

async function saveUserTokens(userId: string, tokens: OAuthTokens): Promise<void> {
  const scope = tokenScope(userId);
  const accessEnc = JSON.stringify(encryptSecret(tokens.access_token, scope));
  const refreshEnc = tokens.refresh_token
    ? JSON.stringify(encryptSecret(tokens.refresh_token, scope))
    : null;
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  const now = new Date();

  const existing = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')),
  });

  if (existing) {
    await db
      .update(oauthAccounts)
      .set({
        accessToken: accessEnc,
        refreshToken: refreshEnc,
        tokenExpiresAt: expiresAt,
        scopes: tokens.scope ?? existing.scopes,
        refreshTokenRotatedAt: tokens.refresh_token ? now : existing.refreshTokenRotatedAt,
        updatedAt: now,
      })
      .where(eq(oauthAccounts.id, existing.id));
  } else {
    await db.insert(oauthAccounts).values({
      userId,
      provider: 'atlassian',
      providerAccountId: userId, // Filled with real cloudId once /resources is queried
      accessToken: accessEnc,
      refreshToken: refreshEnc,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? null,
      refreshTokenRotatedAt: now,
    });
  }
}

export async function deleteUserTokens(userId: string): Promise<void> {
  await db
    .delete(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')));
}

// =============================================================================
// DCR client registration storage (shared, one row per MCP server URL)
// =============================================================================

async function loadClientInfo(): Promise<OAuthClientInformationFull | undefined> {
  const row = await db.query.mcpOauthClients.findFirst({
    where: eq(mcpOauthClients.serverUrl, ATLASSIAN_MCP_SERVER_URL),
  });
  if (!row) return undefined;
  // registrationMetadata holds the full DCR response (includes redirect_uris
  // etc.). The split-out client_id/secret columns exist for SQL-level
  // queryability — the full object is what the SDK actually needs.
  return row.registrationMetadata as OAuthClientInformationFull;
}

async function saveClientInfo(info: OAuthClientInformationFull): Promise<void> {
  const existing = await db.query.mcpOauthClients.findFirst({
    where: eq(mcpOauthClients.serverUrl, ATLASSIAN_MCP_SERVER_URL),
  });
  const now = new Date();
  if (existing) {
    await db
      .update(mcpOauthClients)
      .set({
        clientId: info.client_id,
        clientSecret: info.client_secret ?? null,
        registrationMetadata: info as unknown as Record<string, unknown>,
        updatedAt: now,
      })
      .where(eq(mcpOauthClients.id, existing.id));
  } else {
    await db.insert(mcpOauthClients).values({
      serverUrl: ATLASSIAN_MCP_SERVER_URL,
      clientId: info.client_id,
      clientSecret: info.client_secret ?? null,
      registrationMetadata: info as unknown as Record<string, unknown>,
    });
  }
}

// =============================================================================
// OAuthClientProvider implementation
// =============================================================================

/** Resolve callback URL once, from env so dev/prod just point at their own. */
function getRedirectUrl(): string {
  const env = getEnv();
  const base = env.APP_PUBLIC_URL ?? env.BACKEND_URL;
  return `${base.replace(/\/$/, '')}/api/integrations/atlassian/oauth/callback`;
}

/**
 * Per-user, per-request provider instance. Pass `pendingState` when finishing
 * an OAuth flow so we look up the codeVerifier saved during /oauth/start.
 *
 * `capturedAuthorizationUrl` holds the URL that SDK passes to
 * `redirectToAuthorization` — the HTTP `/oauth/start` route reads this after
 * the expected UnauthorizedError to issue a 302 to the user's browser.
 */
class AtlassianOAuthProvider implements OAuthClientProvider {
  capturedAuthorizationUrl?: URL;

  constructor(
    private userId: string,
    private pendingState?: string
  ) {
    ensureSweeper();
  }

  get redirectUrl(): string {
    return getRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [getRedirectUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client (no secret)
    };
  }

  async clientInformation() {
    return loadClientInfo();
  }

  async saveClientInformation(info: OAuthClientInformationFull) {
    logger.info({ client_id: info.client_id }, '[AtlassianMcpClient] DCR registration cached');
    await saveClientInfo(info);
  }

  async tokens() {
    return loadUserTokens(this.userId);
  }

  async saveTokens(tokens: OAuthTokens) {
    await saveUserTokens(this.userId, tokens);
  }

  async saveCodeVerifier(codeVerifier: string) {
    // SDK calls this before redirectToAuthorization. We tag the verifier
    // with the OAuth state param so the callback can fetch it back.
    if (!this._stateForSave) {
      throw new Error('[AtlassianMcpClient] saveCodeVerifier called without state context');
    }
    pkceStore.set(this._stateForSave, {
      codeVerifier,
      userId: this.userId,
      createdAt: Date.now(),
    });
  }

  async codeVerifier() {
    const state = this.pendingState;
    if (!state) {
      throw new Error('[AtlassianMcpClient] codeVerifier requested without state');
    }
    const entry = pkceStore.get(state);
    if (!entry) {
      throw new Error(
        '[AtlassianMcpClient] codeVerifier not found — flow expired or state mismatch'
      );
    }
    if (entry.userId !== this.userId) {
      throw new Error('[AtlassianMcpClient] codeVerifier state belongs to a different user');
    }
    return entry.codeVerifier;
  }

  // SDK's state() runs *before* saveCodeVerifier — we generate the state here
  // and stash it so saveCodeVerifier can key the PKCE entry by it.
  private _stateForSave?: string;
  state() {
    const s = randomState();
    this._stateForSave = s;
    return s;
  }

  redirectToAuthorization(url: URL) {
    this.capturedAuthorizationUrl = url;
  }
}

function randomState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
}

// =============================================================================
// Public API consumed by HTTP routes + pipeline
// =============================================================================

/**
 * Build the Atlassian authorization URL for a given user.
 * Triggers DCR (cached) + PKCE on first call, returns null if the user is
 * already authenticated (UI should treat this as "already connected").
 *
 * Also returns the OAuth `state` so the route handler can drop it in a
 * cookie or just pass it through the callback.
 */
export async function getAuthorizationUrl(
  userId: string
): Promise<{ url: string; state: string } | null> {
  const provider = new AtlassianOAuthProvider(userId);
  const transport = new StreamableHTTPClientTransport(new URL(ATLASSIAN_MCP_SERVER_URL), {
    authProvider: provider,
  });
  const client = new Client({ name: 'akis-platform', version: '0.7.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    // No throw → user already has a valid token
    await client.close();
    return null;
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
  }

  if (!provider.capturedAuthorizationUrl) {
    throw new Error('[AtlassianMcpClient] SDK did not produce an authorization URL');
  }

  const url = provider.capturedAuthorizationUrl;
  // SDK puts state in the URL; pull it back out so callers can persist it.
  const state = url.searchParams.get('state');
  if (!state) {
    throw new Error('[AtlassianMcpClient] authorization URL missing state param');
  }
  return { url: url.toString(), state };
}

/**
 * Complete the OAuth flow with the authorization code received at the
 * callback endpoint. Persists tokens to oauth_accounts.
 *
 * After this returns, the user has a working MCP session.
 */
export async function finishOAuth(userId: string, code: string, state: string): Promise<void> {
  const provider = new AtlassianOAuthProvider(userId, state);
  const transport = new StreamableHTTPClientTransport(new URL(ATLASSIAN_MCP_SERVER_URL), {
    authProvider: provider,
  });
  try {
    await transport.finishAuth(code);
  } finally {
    pkceStore.delete(state); // single-use, regardless of outcome
  }
}

/**
 * Open a ready-to-use MCP `Client` for the given user. Returns null if the
 * user is not (yet) connected. Callers are responsible for `client.close()`.
 */
export async function openMcpClient(userId: string): Promise<Client | null> {
  const tokens = await loadUserTokens(userId);
  if (!tokens) return null;

  const provider = new AtlassianOAuthProvider(userId);
  const transport = new StreamableHTTPClientTransport(new URL(ATLASSIAN_MCP_SERVER_URL), {
    authProvider: provider,
  });
  const client = new Client({ name: 'akis-platform', version: '0.7.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    if (isUnauthorized(err)) {
      // Refresh failed — clear stale tokens, force user to reconnect.
      logger.warn(
        { userId },
        '[AtlassianMcpClient] auth failed during reconnect — clearing tokens'
      );
      await deleteUserTokens(userId);
      return null;
    }
    throw err;
  }
}

export type AtlassianConnectionStatus = {
  connected: boolean;
  scopes?: string;
  tokenExpiresAt?: Date | null;
  cloudId?: string;
  siteUrl?: string;
};

export async function getConnectionStatus(userId: string): Promise<AtlassianConnectionStatus> {
  const row = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')),
  });
  if (!row?.accessToken) return { connected: false };
  return {
    connected: true,
    scopes: row.scopes ?? undefined,
    tokenExpiresAt: row.tokenExpiresAt ?? undefined,
    cloudId: row.cloudId ?? undefined,
    siteUrl: row.siteUrl ?? undefined,
  };
}

// =============================================================================
// Utils
// =============================================================================

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: number };
  if (e.name === 'UnauthorizedError') return true;
  if (e.code === 401) return true;
  return typeof e.message === 'string' && /unauthorized|401/i.test(e.message);
}

// Test seam: clear the in-memory PKCE map (used by unit tests; never call from prod code)
export function __resetPkceStoreForTests(): void {
  pkceStore.clear();
}
