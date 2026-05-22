/**
 * Phase 0 spike: connect AKIS backend to Atlassian Remote MCP (authv2) using
 * DCR + OAuth 2.1, then list available tools.
 *
 * Run with: pnpm -C backend exec tsx scripts/atlassian-mcp-spike.mts
 *
 * What this proves (or disproves):
 *   1. Localhost callback works with Atlassian's MCP authv2 endpoint
 *   2. DCR (Dynamic Client Registration) succeeds — no developer.atlassian.com app needed
 *   3. Streamable HTTP transport is what authv2 speaks
 *   4. Tool catalogue (what method names + schemas Atlassian exposes)
 *
 * Token + client registration cached to .atlassian-mcp-spike-cache.json so
 * re-runs skip the browser dance.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = resolve(__dirname, '../.atlassian-mcp-spike-cache.json');
const CALLBACK_PORT = 4567; // independent of AKIS dev port (3000) so we don't clash
const CALLBACK_PATH = '/oauth-callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const MCP_SERVER_URL = 'https://mcp.atlassian.com/v1/mcp/authv2';

type SpikeCache = {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

function loadCache(): SpikeCache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(patch: Partial<SpikeCache>) {
  const merged = { ...loadCache(), ...patch };
  writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2));
}

function openInBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort, user can copy URL manually */ });
}

/** Catch the OAuth redirect on http://localhost:4567/oauth-callback?code=... */
function waitForAuthorizationCode(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(`<h1>OAuth error: ${error}</h1>`);
        server.close();
        rejectP(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') ?? ''}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' }).end('<h1>missing code</h1>');
        server.close();
        rejectP(new Error('No code in callback'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<h1>✅ Authorized</h1><p>You can close this tab and return to the terminal.</p>'
      );
      server.close();
      resolveP(code);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`[spike] OAuth callback listener live on ${REDIRECT_URI}`);
    });
    server.on('error', rejectP);
  });
}

/** Single-user, file-cache OAuthClientProvider — spike only, NOT production. */
class SpikeAuthProvider implements OAuthClientProvider {
  get redirectUrl(): string { return REDIRECT_URI; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AKIS Phase-0 Spike',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client
      scope: 'offline_access read:jira-work read:jira-user write:jira-work',
    };
  }

  clientInformation() { return loadCache().clientInformation; }
  saveClientInformation(info: OAuthClientInformationFull) {
    console.log(`[spike] DCR success — client_id=${info.client_id}`);
    saveCache({ clientInformation: info });
  }

  tokens() {
    const raw = loadCache().tokens;
    if (!raw) return undefined;
    console.log('[spike] tokens() returning raw fields:', Object.keys(raw).join(','));
    // Mimic prod: reconstruct from just the standard 4 fields.
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      token_type: 'Bearer',
      expires_in: raw.expires_in,
      scope: raw.scope,
    };
  }
  saveTokens(t: OAuthTokens) {
    console.log(`[spike] tokens stored (fields=${Object.keys(t).join(',')}, expires_in=${t.expires_in ?? '?'}s, refresh=${t.refresh_token ? 'yes' : 'no'})`);
    saveCache({ tokens: t });
  }

  saveCodeVerifier(v: string) { saveCache({ codeVerifier: v }); }
  codeVerifier() {
    const v = loadCache().codeVerifier;
    if (!v) throw new Error('codeVerifier not saved');
    return v;
  }

  async redirectToAuthorization(url: URL) {
    console.log('\n[spike] Authorize in browser:');
    console.log(`        ${url.toString()}\n`);
    openInBrowser(url.toString());
  }
}

async function main() {
  console.log('[spike] Atlassian MCP authv2 connection test');
  console.log(`[spike] Server: ${MCP_SERVER_URL}`);
  console.log(`[spike] Redirect: ${REDIRECT_URI}\n`);

  const authProvider = new SpikeAuthProvider();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), { authProvider });
  const client = new Client(
    { name: 'akis-spike', version: '0.0.1' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
  } catch (e: any) {
    if (e?.name === 'UnauthorizedError' || /unauthorized/i.test(String(e?.message))) {
      console.log('[spike] Auth required — starting OAuth dance...');
      const code = await waitForAuthorizationCode();
      console.log('[spike] Got authorization code, exchanging for tokens...');
      await transport.finishAuth(code);
      console.log('[spike] Reconnecting with token...');
      const transport2 = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), { authProvider });
      await client.connect(transport2);
    } else {
      throw e;
    }
  }

  console.log('\n[spike] ✅ Connected. Calling getAccessibleAtlassianResources...\n');
  try {
    const result = await client.callTool({
      name: 'getAccessibleAtlassianResources',
      arguments: {},
    });
    console.log('[spike] result.isError:', result.isError);
    const content = Array.isArray(result.content) ? result.content : [];
    for (const c of content) {
      console.log('[spike] content item:', JSON.stringify(c).slice(0, 500));
    }
  } catch (err) {
    console.error('[spike] callTool threw:', err);
  }

  await client.close();
  console.log('[spike] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[spike] FAILED:', err);
  process.exit(1);
});
