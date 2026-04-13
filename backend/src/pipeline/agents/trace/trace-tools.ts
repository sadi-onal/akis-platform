/**
 * Trace Agent tool definitions for Claude API tool_use.
 * Trace uses tools to read codebase from GitHub and push test files.
 */
import type { ToolDefinition, ToolHandlerMap } from '../../../services/ai/tool-schemas.js';

export const TRACE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List all source files in a GitHub repository branch. Returns array of file paths.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Branch name (e.g. "main")' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the content of a single file from a GitHub repository.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Branch name' },
        filePath: { type: 'string', description: 'Path to the file (e.g. "src/App.tsx")' },
      },
      required: ['owner', 'repo', 'branch', 'filePath'],
    },
  },
  {
    name: 'push_files',
    description: 'Push test files to a GitHub repository branch in a single atomic commit.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Target branch' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
              content: { type: 'string', description: 'File content' },
            },
            required: ['path', 'content'],
          },
          description: 'Test files to push',
        },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['owner', 'repo', 'branch', 'files', 'message'],
    },
  },
  {
    name: 'create_branch',
    description: 'Create a new branch from main for test files.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'New branch name' },
        fromBranch: { type: 'string', description: 'Base branch (default: "main")' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
];

export interface TraceToolDeps {
  listFiles(owner: string, repo: string, branch: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, branch: string, filePath: string): Promise<string>;
  pushFiles(owner: string, repo: string, branch: string, files: Array<{ path: string; content: string }>, message: string): Promise<void>;
  createBranch(owner: string, repo: string, branch: string, fromBranch?: string): Promise<void>;
}

export function createTraceToolHandlers(deps: TraceToolDeps): ToolHandlerMap {
  return {
    list_files: async (input) => {
      const { owner, repo, branch } = input as { owner: string; repo: string; branch: string };
      const files = await deps.listFiles(owner, repo, branch);
      return { files };
    },
    read_file: async (input) => {
      const { owner, repo, branch, filePath } = input as { owner: string; repo: string; branch: string; filePath: string };
      const content = await deps.getFileContent(owner, repo, branch, filePath);
      return { content };
    },
    push_files: async (input) => {
      const { owner, repo, branch, files, message } = input as {
        owner: string; repo: string; branch: string;
        files: Array<{ path: string; content: string }>; message: string;
      };
      await deps.pushFiles(owner, repo, branch, files, message);
      return { success: true, filesCount: files.length };
    },
    create_branch: async (input) => {
      const { owner, repo, branch, fromBranch } = input as { owner: string; repo: string; branch: string; fromBranch?: string };
      await deps.createBranch(owner, repo, branch, fromBranch);
      return { success: true };
    },
  };
}
