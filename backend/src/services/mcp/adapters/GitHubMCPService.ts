import { HttpClient } from '../../http/HttpClient.js';
import { logger } from '../../../lib/logger.js';
import { randomUUID } from 'crypto';

/**
 * GitHubMCPService - MCP client adapter for GitHub
 * Phase 5.B: Implements MCP JSON-RPC 2.0 calls
 * Provides high-level methods that internally use JSON-RPC 2.0 to GitHub MCP endpoint
 */

export interface GitHubMCPServiceOptions {
  baseUrl: string;
  token?: string;
  httpClient?: HttpClient;
  /**
   * Correlation ID forwarded to the MCP Gateway via `x-correlation-id`.
   * If not provided, a UUID is generated per service instance.
   *
   * NOTE: This is safe to surface in UI/logs (no secrets).
   */
  correlationId?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: string | number | null;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpToolsListResult {
  tools: McpToolInfo[];
}

interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface GitHubLatestRelease {
  id: string | null;
  tagName: string | null;
  name: string | null;
  url: string | null;
  publishedAt: Date | null;
}

/**
 * Stable error codes for MCP-related failures.
 * These are used in job error payloads for consistent error handling.
 */
export enum McpErrorCode {
  // Configuration errors
  MCP_CONFIG_MISSING = 'MCP_CONFIG_MISSING',
  MCP_URL_INVALID = 'MCP_URL_INVALID',
  
  // Connection errors
  MCP_UNREACHABLE = 'MCP_UNREACHABLE',
  MCP_TIMEOUT = 'MCP_TIMEOUT',
  MCP_DNS_FAILED = 'MCP_DNS_FAILED',
  
  // Auth errors
  MCP_UNAUTHORIZED = 'MCP_UNAUTHORIZED',
  MCP_FORBIDDEN = 'MCP_FORBIDDEN',
  MCP_RATE_LIMITED = 'MCP_RATE_LIMITED',
  
  // Protocol errors
  MCP_PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR',
  MCP_TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',
  MCP_RESOURCE_NOT_FOUND = 'MCP_RESOURCE_NOT_FOUND',
  
  // Server errors
  MCP_SERVER_ERROR = 'MCP_SERVER_ERROR',
}

export class McpError extends Error {
  readonly mcpCode: number;
  readonly mcpMethod: string;
  readonly correlationId: string;
  readonly mcpData?: unknown;
  /** Stable, actionable error code for UI/logging */
  readonly code: McpErrorCode;
  /** User-friendly hint on how to fix the issue */
  readonly hint?: string;
  /** Redacted gateway URL (host/port only, no secrets) */
  readonly gatewayUrl?: string;

  constructor(opts: {
    code: number;
    method: string;
    message: string;
    correlationId: string;
    data?: unknown;
    errorCode?: McpErrorCode;
    hint?: string;
    gatewayUrl?: string;
  }) {
    super(opts.message);
    this.name = 'McpError';
    this.mcpCode = opts.code;
    this.mcpMethod = opts.method;
    this.correlationId = opts.correlationId;
    this.mcpData = opts.data;
    this.code = opts.errorCode || McpErrorCode.MCP_PROTOCOL_ERROR;
    this.hint = opts.hint;
    this.gatewayUrl = opts.gatewayUrl;
  }

  /**
   * Safe, user-facing summary (no secrets, no payload dumps).
   */
  toUserMessage(): string {
    const base = `MCP Error [${this.mcpCode}]: ${this.message}`;
    return `${base} (Correlation ID: ${this.correlationId})`;
  }
}

/**
 * Error thrown when MCP Gateway is unreachable or connection fails.
 * Maps low-level network errors to actionable hints.
 */
export class McpConnectionError extends McpError {
  /** Original error cause (sanitized for logging) */
  readonly cause?: string;

  constructor(opts: {
    correlationId: string;
    gatewayUrl: string;
    cause: string;
    errorCode: McpErrorCode;
    hint: string;
  }) {
    // Redact URL to just host/port
    const redactedUrl = McpConnectionError.redactUrl(opts.gatewayUrl);
    
    super({
      code: -32000, // Custom JSON-RPC error code for connection failures
      method: 'connection',
      message: `Failed to connect to MCP Gateway: ${opts.cause}`,
      correlationId: opts.correlationId,
      errorCode: opts.errorCode,
      hint: opts.hint,
      gatewayUrl: redactedUrl,
    });
    this.name = 'McpConnectionError';
    this.cause = opts.cause;
  }

  /**
   * Redact URL to host/port only (no path, query, or auth)
   */
  static redactUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '[invalid URL]';
    }
  }

  /**
   * Map a network error to a structured McpConnectionError with actionable hint.
   */
  static fromNetworkError(
    error: Error,
    correlationId: string,
    gatewayUrl: string
  ): McpConnectionError {
    const errorMessage = error.message.toLowerCase();
    
    // ECONNREFUSED - gateway not running
    if (errorMessage.includes('econnrefused') || errorMessage.includes('connection refused')) {
      return new McpConnectionError({
        correlationId,
        gatewayUrl,
        cause: 'Connection refused',
        errorCode: McpErrorCode.MCP_UNREACHABLE,
        hint: 'MCP Gateway is not running. Start it with: ./scripts/mcp-up.sh',
      });
    }
    
    // ENOTFOUND - DNS resolution failed
    if (errorMessage.includes('enotfound') || errorMessage.includes('getaddrinfo')) {
      return new McpConnectionError({
        correlationId,
        gatewayUrl,
        cause: 'DNS resolution failed',
        errorCode: McpErrorCode.MCP_DNS_FAILED,
        hint: 'Cannot resolve MCP Gateway hostname. Check GITHUB_MCP_BASE_URL in backend/.env',
      });
    }
    
    // ETIMEDOUT - connection timeout
    if (errorMessage.includes('etimedout') || errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
      return new McpConnectionError({
        correlationId,
        gatewayUrl,
        cause: 'Connection timeout',
        errorCode: McpErrorCode.MCP_TIMEOUT,
        hint: 'MCP Gateway is not responding. Check if the gateway is healthy: curl http://localhost:4010/health',
      });
    }
    
    // Fetch failed (generic)
    if (errorMessage.includes('fetch failed') || errorMessage.includes('failed to fetch')) {
      return new McpConnectionError({
        correlationId,
        gatewayUrl,
        cause: 'Network request failed',
        errorCode: McpErrorCode.MCP_UNREACHABLE,
        hint: 'Cannot reach MCP Gateway. Run ./scripts/mcp-doctor.sh to diagnose the issue.',
      });
    }
    
    // Generic fallback
    return new McpConnectionError({
      correlationId,
      gatewayUrl,
      cause: error.message,
      errorCode: McpErrorCode.MCP_UNREACHABLE,
      hint: 'MCP Gateway connection failed. Check if the gateway is running and accessible.',
    });
  }

  /**
   * Map HTTP status codes to structured McpConnectionError.
   */
  static fromHttpStatus(
    status: number,
    statusText: string,
    correlationId: string,
    gatewayUrl: string
  ): McpConnectionError {
    switch (status) {
      case 401:
        return new McpConnectionError({
          correlationId,
          gatewayUrl,
          cause: `Unauthorized (${status})`,
          errorCode: McpErrorCode.MCP_UNAUTHORIZED,
          hint: 'Invalid or missing GitHub token. Check GITHUB_TOKEN in .env.mcp.local',
        });
      case 403:
        return new McpConnectionError({
          correlationId,
          gatewayUrl,
          cause: `Forbidden (${status})`,
          errorCode: McpErrorCode.MCP_FORBIDDEN,
          hint: 'GitHub token lacks required scopes. Ensure token has: repo, read:org',
        });
      case 429:
        return new McpConnectionError({
          correlationId,
          gatewayUrl,
          cause: `Rate limited (${status})`,
          errorCode: McpErrorCode.MCP_RATE_LIMITED,
          hint: 'GitHub API rate limit exceeded. Wait a few minutes and try again.',
        });
      default:
        if (status >= 500) {
          return new McpConnectionError({
            correlationId,
            gatewayUrl,
            cause: `Server error (${status} ${statusText})`,
            errorCode: McpErrorCode.MCP_SERVER_ERROR,
            hint: 'MCP Gateway server error. Check gateway logs: docker compose -f docker-compose.mcp.yml logs',
          });
        }
        return new McpConnectionError({
          correlationId,
          gatewayUrl,
          cause: `HTTP ${status} ${statusText}`,
          errorCode: McpErrorCode.MCP_PROTOCOL_ERROR,
          hint: 'Unexpected response from MCP Gateway. Check gateway health.',
        });
    }
  }
}

/**
 * GitHub MCP Service - adapter for GitHub MCP server
 * Used by Scribe, Trace, Proto agents
 */
export class GitHubMCPService {
  private baseUrl: string;
  private token?: string;
  private httpClient: HttpClient;
  private requestId: number = 1;
  private correlationId: string;
  private initialized: boolean = false;
  private toolsCache: McpToolInfo[] | null = null;
  private toolsCacheAt: number | null = null;
  private readonly toolsCacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(opts: GitHubMCPServiceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.token = opts.token;
    this.httpClient = opts.httpClient || new HttpClient();
    this.correlationId = opts.correlationId || randomUUID();
  }

  private nextId(): number {
    return this.requestId++;
  }

  private async callJsonRpc<T>(method: string, params?: unknown): Promise<{ result: T; correlationId: string }> {
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.nextId(),
    };

    let response: Response;
    try {
      response = await this.httpClient.post(this.baseUrl, payload, this.token, {
        // Forward correlation ID to gateway for log correlation
        'x-correlation-id': this.correlationId,
      });
    } catch (error) {
      // Network-level failure: ECONNREFUSED, ENOTFOUND, timeout, fetch failed, etc.
      if (error instanceof Error) {
        throw McpConnectionError.fromNetworkError(error, this.correlationId, this.baseUrl);
      }
      throw new McpConnectionError({
        correlationId: this.correlationId,
        gatewayUrl: this.baseUrl,
        cause: String(error),
        errorCode: McpErrorCode.MCP_UNREACHABLE,
        hint: 'MCP Gateway connection failed. Run ./scripts/mcp-doctor.sh to diagnose.',
      });
    }

    const responseCorrelationId = response.headers.get('x-correlation-id') || this.correlationId;

    // Handle HTTP-level errors (401, 403, 429, 5xx) with actionable hints
    if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500)) {
      throw McpConnectionError.fromHttpStatus(
        response.status,
        response.statusText,
        responseCorrelationId,
        this.baseUrl
      );
    }

    let json: JsonRpcResponse<T> | null = null;
    try {
      json = (await response.json()) as JsonRpcResponse<T>;
    } catch {
      // Non-JSON response
      json = null;
    }

    if (!response.ok) {
      const code = json?.error?.code ?? response.status;
      const message = json?.error?.message ?? `MCP Request failed: ${response.status} ${response.statusText}`;
      const data = json?.error?.data;
      throw new McpError({ code, method, message, correlationId: responseCorrelationId, data });
    }

    if (!json) {
      throw new McpError({
        code: -32603,
        method,
        message: 'Invalid MCP response: expected JSON',
        correlationId: responseCorrelationId,
        errorCode: McpErrorCode.MCP_PROTOCOL_ERROR,
        hint: 'MCP Gateway returned non-JSON response. Check gateway health.',
      });
    }

    if (json.error) {
      // Map known JSON-RPC error codes to stable error codes
      let errorCode = McpErrorCode.MCP_PROTOCOL_ERROR;
      let hint: string | undefined;
      
      if (json.error.code === -32601) {
        errorCode = McpErrorCode.MCP_TOOL_NOT_FOUND;
        hint = 'MCP tool not found. This may indicate a protocol mismatch or outdated gateway.';
      }
      if (
        json.error.code === -32603 &&
        typeof json.error.message === 'string' &&
        /resource not found/i.test(json.error.message)
      ) {
        errorCode = McpErrorCode.MCP_RESOURCE_NOT_FOUND;
        hint = 'Resource not found. Check owner/repo/path/branch or token access.';
      }
      
      throw new McpError({
        code: json.error.code,
        method,
        message: json.error.message,
        correlationId: responseCorrelationId,
        data: json.error.data,
        errorCode,
        hint,
      });
    }

    return { result: json.result as T, correlationId: responseCorrelationId };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.callJsonRpc('initialize', {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'akis-backend',
        version: '0.2.0',
      },
    });

    this.initialized = true;
  }

  private async listTools(): Promise<McpToolInfo[]> {
    const now = Date.now();
    if (this.toolsCache && this.toolsCacheAt && now - this.toolsCacheAt < this.toolsCacheTtlMs) {
      return this.toolsCache;
    }

    await this.ensureInitialized();
    const { result } = await this.callJsonRpc<McpToolsListResult>('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    this.toolsCache = tools;
    this.toolsCacheAt = now;
    return tools;
  }

  private parseToolResultJson<T>(toolResult: McpToolCallResult): T {
    const content = toolResult.content;
    if (!Array.isArray(content)) {
      // Some servers might return raw JSON directly
      return toolResult as unknown as T;
    }

    const firstText = content.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
    if (typeof firstText !== 'string') {
      return toolResult as unknown as T;
    }

    try {
      return JSON.parse(firstText) as T;
    } catch {
      // Not JSON - return raw string
      return firstText as unknown as T;
    }
  }

  private async ensureToolAvailable(toolName: string): Promise<void> {
    const tools = await this.listTools();
    const ok = tools.some((t) => t.name === toolName);
    if (!ok) {
      const available = tools.map((t) => t.name).slice(0, 30).join(', ');
      throw new McpError({
        code: -32601,
        method: 'tools/call',
        message: `Tool not found: ${toolName}. Available tools (first 30): ${available}`,
        correlationId: this.correlationId,
      });
    }
  }

  /**
   * Invalidate cached tool list (e.g., after -32601 suggesting drift)
   */
  private invalidateToolsCache(): void {
    this.toolsCache = null;
    this.toolsCacheAt = null;
  }

  private async callTool<T>(toolName: string, args: Record<string, unknown>, retryOnNotFound = true): Promise<T> {
    await this.ensureInitialized();
    await this.ensureToolAvailable(toolName);

    try {
      const { result } = await this.callJsonRpc<McpToolCallResult>('tools/call', {
        name: toolName,
        arguments: args,
      });

      return this.parseToolResultJson<T>(result);
    } catch (err) {
      // Auto-refresh cache and retry once on -32601 (method/tool not found)
      if (err instanceof McpError && err.mcpCode === -32601 && retryOnNotFound) {
        this.invalidateToolsCache();
        // Recursive call with retry disabled to prevent infinite loop
        return this.callTool<T>(toolName, args, false);
      }
      throw err;
    }
  }

  /**
   * Public wrapper for callTool - allows raw tool calls from agents
   * Use with caution; prefer typed wrapper methods when available
   */
  async callToolRaw<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    return this.callTool<T>(toolName, args);
  }

  /**
   * Resolve latest repository release across MCP tool-name variations.
   * Returns null when no release exists or the gateway does not expose release tools.
   */
  async getLatestRelease(owner: string, repo: string): Promise<GitHubLatestRelease | null> {
    const attempts: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'get_latest_release', args: { owner, repo } },
      { tool: 'get_release_latest', args: { owner, repo } },
      { tool: 'list_releases', args: { owner, repo, per_page: 10, page: 1 } },
    ];

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        const raw = await this.callToolRaw<unknown>(attempt.tool, attempt.args);
        const parsed = this.parseLatestRelease(raw);
        if (parsed) {
          return parsed;
        }
      } catch (error) {
        if (error instanceof McpError && error.mcpCode === -32601) {
          continue;
        }
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return null;
  }

  /**
   * Create a branch in GitHub repository
   */
  async createBranch(
    owner: string,
    repo: string,
    branchName: string,
    fromBranch?: string
  ): Promise<{ branch: string; sha: string }> {
    const ref = await this.callTool<{ ref: string; object: { sha: string } }>('create_branch', {
      owner,
      repo,
      branch: branchName,
      ...(fromBranch ? { from_branch: fromBranch } : {}),
    });
    return { branch: branchName, sha: ref.object.sha };
  }

  /**
   * Commit a file to GitHub repository
   */
  async commitFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string
  ): Promise<{ commitSha: string; filePath: string }> {
    const result = await this.callTool<{ commit: { sha: string } }>('create_or_update_file', {
      owner,
      repo,
      path: filePath,
      content,
      message: commitMessage,
      branch,
    });
    return { commitSha: result.commit.sha, filePath };
  }

  /**
   * Get content of a file
   */
  async getFileContent(
    owner: string,
    repo: string,
    branch: string,
    filePath: string
  ): Promise<{ content: string; encoding: 'utf8'; sha: string }> {
    const result = await this.callTool<unknown>('get_file_contents', {
      owner,
      repo,
      path: filePath,
      branch,
    });

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(`Unexpected get_file_contents result for path '${filePath}'`);
    }

    const record = result as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const sha = typeof record.sha === 'string' ? record.sha : '';

    if (!sha) {
      throw new Error(`Missing sha in get_file_contents result for path '${filePath}'`);
    }

    return { content, encoding: 'utf8', sha };
  }

  /**
   * Safe version of getFileContent that returns null instead of throwing
   * for expected "file not found" errors. Use this for exploratory file reads
   * (e.g., gatherRepoContext) to avoid ERROR spam in logs.
   */
  async getFileContentSafe(
    owner: string,
    repo: string,
    branch: string,
    filePath: string
  ): Promise<{ content: string; encoding: 'utf8'; sha: string } | null> {
    try {
      return await this.getFileContent(owner, repo, branch, filePath);
    } catch (error) {
      // Expected "file not found" errors - log at debug level only
      if (error instanceof McpError && (error.mcpCode === -32603 || error.mcpCode === -32601)) {
        // Resource not found or tool not found - expected for optional files
        logger.debug(`[GitHubMCP] File not found (expected): ${filePath}`);
        return null;
      }
      // Network or auth errors should still be thrown
      if (error instanceof McpConnectionError) {
        throw error;
      }
      // For unexpected errors, log at debug and return null (don't spam ERROR)
      logger.debug(`[GitHubMCP] Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get changed files between two refs (or for a PR)
   * Used by Scribe to analyze changes
   */
  async getChangedFiles(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    // NOTE: The official GitHub MCP server does not currently expose a "compareCommits" tool.
    // Keep this method for future use, but fail with actionable guidance.
    void owner;
    void repo;
    void base;
    void head;
    throw new Error(
      'getChangedFiles is not supported by the official GitHub MCP server. ' +
        'Use PR-based diff tools (e.g., get_pull_request_files) when available.'
    );
  }

  /**
   * List repository issues (for Trace agent)
   */
  async listIssues(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<Array<{ number: number; title: string; body?: string }>> {
    return this.callTool<Array<{ number: number; title: string; body?: string }>>('list_issues', {
      owner,
      repo,
      state,
    });
  }

  /**
   * Create a PR draft (for Proto agent)
   */
  async createPRDraft(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<{ prNumber: number; url: string }> {
    const pr = await this.callTool<{ number: number; html_url: string }>('create_pull_request', {
      owner,
      repo,
      title,
      body,
      head,
      base,
      draft: true,
    });
    return { prNumber: pr.number, url: pr.html_url };
  }

  private parseLatestRelease(raw: unknown): GitHubLatestRelease | null {
    const normalizeArray = (items: unknown[]): GitHubLatestRelease | null => {
      const visible = items.find((item) => this.isVisibleRelease(item));
      if (visible) {
        return this.normalizeRelease(visible);
      }
      return items.length > 0 ? this.normalizeRelease(items[0]) : null;
    };

    if (Array.isArray(raw)) {
      return normalizeArray(raw);
    }

    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.releases)) {
      return normalizeArray(record.releases);
    }
    if (record.release && typeof record.release === 'object') {
      return this.normalizeRelease(record.release);
    }

    return this.normalizeRelease(record);
  }

  private isVisibleRelease(input: unknown): boolean {
    if (!input || typeof input !== 'object') {
      return false;
    }

    const record = input as Record<string, unknown>;
    if (typeof record.draft === 'boolean' && record.draft) {
      return false;
    }
    return true;
  }

  private normalizeRelease(input: unknown): GitHubLatestRelease | null {
    if (!input || typeof input !== 'object') {
      return null;
    }

    const record = input as Record<string, unknown>;

    const publishedAtValue =
      record.published_at ??
      record.publishedAt ??
      record.created_at ??
      record.createdAt ??
      null;

    const publishedAt =
      typeof publishedAtValue === 'string'
        ? this.parseDate(publishedAtValue)
        : null;

    return {
      id: this.readString(record.id) ?? this.readString(record.node_id) ?? null,
      tagName: this.readString(record.tag_name) ?? this.readString(record.tagName) ?? null,
      name: this.readString(record.name) ?? null,
      url:
        this.readString(record.html_url) ??
        this.readString(record.url) ??
        this.readString(record.web_url) ??
        null,
      publishedAt,
    };
  }

  private parseDate(value: string): Date | null {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private readString(value: unknown): string | null {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    return null;
  }
}
