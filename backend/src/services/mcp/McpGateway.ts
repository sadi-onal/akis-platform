import { randomUUID } from 'crypto';
import { getEnv } from '../../config/env.js';

type HttpMethod = 'GET' | 'POST';

interface RequestOptions {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
}

interface GitHubOAuthTokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GitHubBasicUser {
  id: number;
  login: string;
  avatar_url?: string;
  created_at?: string;
}

export type AtlassianProvider = 'jira' | 'confluence';

export interface AtlassianConnectionResult {
  success: boolean;
  error?: string;
  displayName?: string;
}

export class McpGatewayError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly correlationId: string;

  constructor(params: { code: string; message: string; correlationId: string; status?: number }) {
    super(params.message);
    this.name = 'McpGatewayError';
    this.code = params.code;
    this.status = params.status;
    this.correlationId = params.correlationId;
  }
}

export class McpGateway {
  private timeoutMs: number;
  private retryCount: number;

  constructor(options?: { timeoutMs?: number; retryCount?: number }) {
    const shouldLoadEnv = options?.timeoutMs === undefined || options?.retryCount === undefined;
    const env = shouldLoadEnv ? getEnv() : null;
    this.timeoutMs = options?.timeoutMs ?? env?.MCP_GATEWAY_TIMEOUT_MS ?? 8000;
    this.retryCount = options?.retryCount ?? env?.MCP_GATEWAY_RETRY_COUNT ?? 2;
  }

  async fetchGitHubJson<T>(
    endpoint: string,
    accessToken: string,
    correlationId?: string
  ): Promise<T> {
    const safeEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return this.requestJson<T>({
      method: 'GET',
      url: `https://api.github.com${safeEndpoint}`,
      correlationId,
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'AKIS-Platform',
      },
    });
  }

  async exchangeGitHubOAuthCode(
    payload: {
      code: string;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
    correlationId?: string
  ): Promise<GitHubOAuthTokenResponse> {
    return this.requestJson<GitHubOAuthTokenResponse>({
      method: 'POST',
      url: 'https://github.com/login/oauth/access_token',
      correlationId,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: {
        client_id: payload.clientId,
        client_secret: payload.clientSecret,
        code: payload.code,
        redirect_uri: payload.redirectUri,
      },
    });
  }

  async fetchGitHubUser(accessToken: string, correlationId?: string): Promise<GitHubBasicUser> {
    return this.fetchGitHubJson<GitHubBasicUser>('/user', accessToken, correlationId);
  }

  async testAtlassianConnection(
    siteUrl: string,
    email: string,
    apiToken: string,
    provider: AtlassianProvider,
    correlationId?: string
  ): Promise<AtlassianConnectionResult> {
    const endpoint = provider === 'jira'
      ? `${siteUrl}/rest/api/3/myself`
      : `${siteUrl}/wiki/rest/api/user/current`;

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const resolvedCorrelationId = correlationId || randomUUID();

    try {
      const response = await this.requestRaw({
        method: 'GET',
        url: endpoint,
        correlationId: resolvedCorrelationId,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 401) {
          return { success: false, error: 'Invalid credentials. Check your email and API token.' };
        }
        if (response.status === 403) {
          return { success: false, error: 'Access forbidden. Your API token may lack required permissions.' };
        }
        return {
          success: false,
          error: `API error (${response.status}): ${errorText.substring(0, 200)}`,
        };
      }

      const data = (await response.json().catch(() => ({}))) as { displayName?: string };
      return { success: true, displayName: data.displayName };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    const response = await this.requestRaw(options);

    if (!response.ok) {
      const correlationId = options.correlationId || randomUUID();
      const errorPayload = await response.json().catch(() => ({}));
      const fallback = `Request failed: ${response.status} ${response.statusText}`;
      const message =
        typeof (errorPayload as { message?: unknown }).message === 'string'
          ? (errorPayload as { message: string }).message
          : fallback;

      throw new McpGatewayError({
        code: 'VENDOR_REQUEST_FAILED',
        message,
        status: response.status,
        correlationId,
      });
    }

    return response.json() as Promise<T>;
  }

  private async requestRaw(options: RequestOptions): Promise<Response> {
    const correlationId = options.correlationId || randomUUID();
    const retries = Math.max(0, this.retryCount);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: {
            ...options.headers,
            'x-correlation-id': correlationId,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const shouldRetry =
          attempt < retries &&
          (response.status === 429 || response.status >= 500);
        if (shouldRetry) {
          await this.delay(this.retryBackoffMs(attempt));
          continue;
        }

        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        const canRetry = attempt < retries;
        if (!canRetry) {
          throw new McpGatewayError({
            code: 'VENDOR_REQUEST_NETWORK_ERROR',
            message: error instanceof Error ? error.message : 'Network request failed',
            correlationId,
          });
        }
        await this.delay(this.retryBackoffMs(attempt));
      }
    }

    throw new McpGatewayError({
      code: 'VENDOR_REQUEST_RETRY_EXHAUSTED',
      message: 'Request retry attempts exhausted',
      correlationId: options.correlationId || randomUUID(),
    });
  }

  private retryBackoffMs(attempt: number): number {
    return 200 * Math.pow(2, attempt);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
