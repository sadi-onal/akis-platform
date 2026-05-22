/**
 * MCP Adapters - Barrel export
 * Phase 11: GitHub (self-hosted gateway) + Jira via Atlassian Remote MCP authv2.
 * Confluence will be added back as a separate adapter when the pipeline starts
 * using it; the OAuth scope is already granted by the same authv2 consent.
 */

import type { GitHubMCPService } from './GitHubMCPService.js';
import type { JiraMCPService } from './JiraMCPService.js';

// Service exports
export { GitHubMCPService } from './GitHubMCPService.js';
export { JiraMCPService } from './JiraMCPService.js';

// Error exports
export { McpError, McpConnectionError, McpErrorCode } from './GitHubMCPService.js';

// Options exports
export type { GitHubMCPServiceOptions } from './GitHubMCPService.js';
export type {
  JiraMCPServiceOptions,
  JiraIssue,
  JiraIssueCreateFields,
  JiraComment,
} from './JiraMCPService.js';

/**
 * MCPTools - Typed bag of MCP adapters for injection into agents.
 * Orchestrator provides this to agents at runtime.
 */
export interface MCPTools {
  githubMCP?: GitHubMCPService;
  jiraMCP?: JiraMCPService;
}
