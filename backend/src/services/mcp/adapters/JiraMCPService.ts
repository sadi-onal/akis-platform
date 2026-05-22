/**
 * JiraMCPService — Jira adapter on top of Atlassian's remote MCP server
 * (https://mcp.atlassian.com/v1/mcp/authv2), using the official MCP SDK +
 * Dynamic Client Registration + OAuth 2.1 via `AtlassianMcpClient`.
 *
 * Public surface (createIssue, linkIssues, addComment, getTransitions,
 * transitionIssue) is kept stable so `jiraIntegration.ts` and the pipeline
 * orchestrator don't need to change.
 *
 * Internally every call goes through SDK's `client.callTool(name, args)`.
 * Atlassian tools need a `cloudId` on each call — we resolve it once via
 * `getAccessibleAtlassianResources`, cache it on the oauth_accounts row, and
 * inject it transparently.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { oauthAccounts } from '../../../db/schema.js';
import { openMcpClient } from '../../atlassian/AtlassianMcpClient.js';
import { logger } from '../../../lib/logger.js';

// =============================================================================
// Public types (preserved for consumers — do not rename without sweep)
// =============================================================================

export interface JiraMCPServiceOptions {
  client: Client;
  cloudId: string;
  /** OPTIONAL: siteUrl is for human-facing URL building (`/browse/${key}`). */
  siteUrl?: string;
}

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
// MCP result-shape helpers
// =============================================================================

// Use SDK's actual inferred return type so Zod schema variance doesn't bite us.
type ClientCallResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Atlassian MCP tools return their payload as JSON-stringified text inside
 * `content[0].text`. Some newer tools also fill `structuredContent` — prefer
 * that when present. Throws if the tool reported `isError`.
 */
function unwrap<T = unknown>(result: ClientCallResult, toolName: string): T {
  if (result.isError) {
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const msg =
      first && (first as { type?: string; text?: string }).type === 'text'
        ? (first as { text: string }).text
        : 'unknown';
    throw new Error(`[${toolName}] tool returned error: ${msg}`);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || (first as { type?: string }).type !== 'text') {
    throw new Error(`[${toolName}] unexpected MCP result shape`);
  }
  const text = (first as { text: string }).text;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some tools return plain text (e.g. confirmations). Return raw string.
    return text as unknown as T;
  }
}

// =============================================================================
// JiraMCPService
// =============================================================================

export class JiraMCPService {
  private client: Client;
  private cloudId: string;
  public readonly siteUrl?: string;

  constructor(opts: JiraMCPServiceOptions) {
    this.client = opts.client;
    this.cloudId = opts.cloudId;
    this.siteUrl = opts.siteUrl;
  }

  /**
   * Factory: build a JiraMCPService for the given user, or null if the user
   * has not connected Atlassian. Resolves cloudId once (cached on the
   * oauth_accounts row after first resolution). Caller is responsible for
   * `service.close()` — typically a try/finally inside the orchestrator.
   */
  static async fromOAuth(userId: string): Promise<JiraMCPService | null> {
    const client = await openMcpClient(userId);
    if (!client) return null;

    let cloudId: string | undefined;
    let siteUrl: string | undefined;
    try {
      const row = await db.query.oauthAccounts.findFirst({
        where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')),
      });
      cloudId = row?.cloudId ?? undefined;
      siteUrl = row?.siteUrl ?? undefined;

      if (!cloudId) {
        // First post-OAuth call — discover the user's primary site.
        const resources = unwrap<AccessibleResource[]>(
          await client.callTool({ name: 'getAccessibleAtlassianResources', arguments: {} }),
          'getAccessibleAtlassianResources'
        );
        if (!Array.isArray(resources) || resources.length === 0) {
          logger.warn({ userId }, '[Jira] user has no accessible Atlassian sites');
          await client.close();
          return null;
        }
        // TODO Phase 2: surface multi-site picker if resources.length > 1.
        cloudId = resources[0].id;
        siteUrl = resources[0].url;
        await db
          .update(oauthAccounts)
          .set({ cloudId, siteUrl, providerAccountId: cloudId, updatedAt: new Date() })
          .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'atlassian')));
      }
    } catch (err) {
      logger.warn({ userId, err }, '[Jira] cloudId resolution failed');
      await client.close();
      return null;
    }

    return new JiraMCPService({ client, cloudId, siteUrl });
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {
      /* close is best-effort */
    });
  }

  // ───── Public methods (preserved signatures) ─────

  /**
   * List projects the user can create issues in (used by the chat-side picker
   * shown on the spec-approval card so the user can opt-in to a Jira Epic).
   * Capped at 50 since the dropdown is human-scale; consumers needing more
   * should call the underlying tool directly with pagination.
   */
  async listProjects(): Promise<Array<{ key: string; name: string }>> {
    const result = unwrap<
      | {
          values?: Array<{ key: string; name: string }>;
          projects?: Array<{ key: string; name: string }>;
        }
      | Array<{ key: string; name: string }>
    >(
      await this.client.callTool({
        name: 'getVisibleJiraProjects',
        arguments: { cloudId: this.cloudId, action: 'create', maxResults: 50 },
      }),
      'getVisibleJiraProjects'
    );
    // Atlassian shape can be { values: [...] }, { projects: [...] }, or a bare array.
    const rows = Array.isArray(result) ? result : (result.values ?? result.projects ?? []);
    return rows.map((p) => ({ key: p.key, name: p.name }));
  }

  async createIssue(
    projectKey: string,
    fields: JiraIssueCreateFields
  ): Promise<{ key: string; id: string }> {
    const result = unwrap<{ key: string; id: string }>(
      await this.client.callTool({
        name: 'createJiraIssue',
        arguments: {
          cloudId: this.cloudId,
          projectKey,
          issueTypeName: fields.issueType,
          summary: fields.summary,
          description: fields.description,
          ...(fields.assignee ? { assignee_account_id: fields.assignee } : {}),
          ...(fields.labels?.length || fields.customFields
            ? {
                additional_fields: {
                  ...(fields.labels?.length ? { labels: fields.labels } : {}),
                  ...(fields.customFields ?? {}),
                },
              }
            : {}),
        },
      }),
      'createJiraIssue'
    );
    return { key: result.key, id: result.id };
  }

  async addComment(issueKey: string, body: string): Promise<JiraComment> {
    const result = unwrap<JiraComment>(
      await this.client.callTool({
        name: 'addCommentToJiraIssue',
        arguments: {
          cloudId: this.cloudId,
          issueIdOrKey: issueKey,
          commentBody: body,
          contentFormat: 'markdown',
        },
      }),
      'addCommentToJiraIssue'
    );
    return result;
  }

  async getTransitions(
    issueKey: string
  ): Promise<{ transitions: Array<{ id: string; name: string }> }> {
    const result = unwrap<{ transitions: Array<{ id: string; name: string }> }>(
      await this.client.callTool({
        name: 'getTransitionsForJiraIssue',
        arguments: { cloudId: this.cloudId, issueIdOrKey: issueKey },
      }),
      'getTransitionsForJiraIssue'
    );
    return result;
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<{ success: boolean }> {
    // transitionJiraIssue returns 204/empty on success → unwrap may yield ''.
    await this.client.callTool({
      name: 'transitionJiraIssue',
      arguments: {
        cloudId: this.cloudId,
        issueIdOrKey: issueKey,
        transition: { id: transitionId },
      },
    });
    return { success: true };
  }

  async linkIssues(
    inwardIssueKey: string,
    outwardIssueKey: string,
    linkType: string
  ): Promise<{ success: boolean }> {
    await this.client.callTool({
      name: 'createIssueLink',
      arguments: {
        cloudId: this.cloudId,
        inwardIssue: inwardIssueKey,
        outwardIssue: outwardIssueKey,
        type: linkType,
      },
    });
    return { success: true };
  }
}

type AccessibleResource = { id: string; url: string; name?: string };
