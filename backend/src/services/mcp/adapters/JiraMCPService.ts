import { HttpClient } from '../../http/HttpClient.js';
import { atlassianOAuthService } from '../../atlassian/index.js';
import { getEnv } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';

/**
 * JiraMCPService - MCP client adapter for Jira
 * Phase 10: Full MCP JSON-RPC 2.0 implementation
 * Provides high-level methods that internally use JSON-RPC 2.0 to Jira MCP endpoint
 * 
 * Supports OAuth 2.0 (3LO) tokens via fromOAuth factory method
 */

export interface JiraMCPServiceOptions {
  baseUrl: string;
  token?: string;
  httpClient?: HttpClient;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
  id: string | number;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number;
}

// =============================================================================
// Jira Types
// =============================================================================

export interface JiraIssue {
  key: string;
  id: string;
  summary: string;
  description?: string;
  acceptanceCriteria?: string;
  status?: string;
  issueType?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  created?: string;
  updated?: string;
}

export interface JiraIssueCreateFields {
  summary: string;
  description?: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  customFields?: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated?: string;
}

// =============================================================================
// JiraMCPService Class
// =============================================================================

/**
 * Jira MCP Service - adapter for Jira MCP server
 * Used by Trace agent for issue tracking
 */
export class JiraMCPService {
  private baseUrl: string;
  private token?: string;
  private httpClient: HttpClient;
  private requestId: number = 1;

  constructor(opts: JiraMCPServiceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.token = opts.token;
    this.httpClient = opts.httpClient || new HttpClient();
  }

  /**
   * Factory method to create JiraMCPService using Atlassian OAuth tokens
   * @param userId - AKIS user ID
   * @returns JiraMCPService instance or null if OAuth is not available
   */
  static async fromOAuth(userId: string): Promise<JiraMCPService | null> {
    const env = getEnv();

    if (!env.ATLASSIAN_MCP_BASE_URL) {
      // Server is not configured for Jira at all — silent skip is fine here,
      // it's a deploy-time fact, not a per-request anomaly.
      return null;
    }

    let token: string | null = null;
    try {
      token = await atlassianOAuthService.getValidToken(userId);
    } catch (err) {
      // Token decryption / refresh failed. The pipeline is best-effort with
      // Jira; surface the reason in logs so prod regressions are debuggable.
      logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        '[Jira] fromOAuth: getValidToken threw — returning null'
      );
      return null;
    }

    if (!token) {
      logger.warn(
        { userId },
        '[Jira] fromOAuth: no valid token (user likely never connected Atlassian, or token rotation failed) — returning null'
      );
      return null;
    }

    return new JiraMCPService({
      baseUrl: env.ATLASSIAN_MCP_BASE_URL,
      token,
    });
  }

  /**
   * Make a JSON-RPC 2.0 call to the Jira MCP server
   */
  private async callMcp<T>(method: string, params: unknown): Promise<T> {
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: `jira/${method}`, // Namespaced method
      params,
      id: this.requestId++,
    };

    const response = await this.httpClient.post(this.baseUrl, payload, this.token);

    if (!response.ok) {
      throw new Error(`Jira MCP Request failed: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as JsonRpcResponse<T>;

    if (json.error) {
      throw new Error(`Jira MCP Error [${json.error.code}]: ${json.error.message}`);
    }

    return json.result as T;
  }

  /**
   * Get a Jira issue by key
   * @param issueKey - Issue key (e.g., PROJ-123)
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.callMcp<JiraIssue>('getIssue', { issueKey });
  }

  /**
   * List issues for a project
   * @param projectKey - Project key
   * @param options - Query options
   */
  async listIssues(
    projectKey: string,
    options?: {
      jql?: string;
      maxResults?: number;
      startAt?: number;
      fields?: string[];
    }
  ): Promise<{ issues: JiraIssue[]; total: number; startAt: number; maxResults: number }> {
    // Build JQL if not provided
    const jql = options?.jql || `project = ${projectKey} ORDER BY created DESC`;
    
    return this.callMcp<{ issues: JiraIssue[]; total: number; startAt: number; maxResults: number }>(
      'searchIssues',
      {
        jql,
        maxResults: options?.maxResults || 50,
        startAt: options?.startAt || 0,
        fields: options?.fields || ['summary', 'description', 'status', 'assignee', 'priority'],
      }
    );
  }

  /**
   * Create a Jira issue
   * @param projectKey - Project key
   * @param fields - Issue fields
   */
  async createIssue(projectKey: string, fields: JiraIssueCreateFields): Promise<{ key: string; id: string }> {
    return this.callMcp<{ key: string; id: string }>('createIssue', {
      projectKey,
      fields,
    });
  }

  /**
   * Update a Jira issue
   * @param issueKey - Issue key
   * @param fields - Fields to update
   */
  async updateIssue(issueKey: string, fields: Partial<JiraIssueCreateFields>): Promise<{ success: boolean }> {
    return this.callMcp<{ success: boolean }>('updateIssue', {
      issueKey,
      fields,
    });
  }

  /**
   * Add a comment to a Jira issue
   * @param issueKey - Issue key
   * @param comment - Comment text
   */
  async addComment(issueKey: string, comment: string): Promise<JiraComment> {
    return this.callMcp<JiraComment>('addComment', {
      issueKey,
      body: comment,
    });
  }

  /**
   * Get comments for a Jira issue
   * @param issueKey - Issue key
   */
  async getComments(issueKey: string): Promise<{ comments: JiraComment[] }> {
    return this.callMcp<{ comments: JiraComment[] }>('getComments', { issueKey });
  }

  /**
   * Transition an issue to a new status
   * @param issueKey - Issue key
   * @param transitionId - Transition ID or name
   */
  async transitionIssue(issueKey: string, transitionId: string): Promise<{ success: boolean }> {
    return this.callMcp<{ success: boolean }>('transitionIssue', {
      issueKey,
      transitionId,
    });
  }

  /**
   * Get available transitions for an issue
   * @param issueKey - Issue key
   */
  async getTransitions(issueKey: string): Promise<{ transitions: Array<{ id: string; name: string }> }> {
    return this.callMcp<{ transitions: Array<{ id: string; name: string }> }>('getTransitions', { issueKey });
  }

  /**
   * Link two issues
   * @param inwardIssueKey - Source issue
   * @param outwardIssueKey - Target issue
   * @param linkType - Link type (e.g., "blocks", "relates to")
   */
  async linkIssues(
    inwardIssueKey: string,
    outwardIssueKey: string,
    linkType: string
  ): Promise<{ success: boolean }> {
    return this.callMcp<{ success: boolean }>('linkIssues', {
      inwardIssueKey,
      outwardIssueKey,
      linkType,
    });
  }
}
