/**
 * Proto Agent tool definitions for Claude API tool_use.
 * Proto uses tools to create GitHub repos and push scaffold files.
 */
import type { ToolDefinition, ToolHandlerMap } from '../../../services/ai/tool-schemas.js';

export const PROTO_TOOLS: ToolDefinition[] = [
  {
    name: 'create_repository',
    description: 'Create a new GitHub repository. Returns the repository URL.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        name: { type: 'string', description: 'Repository name' },
        isPrivate: { type: 'boolean', description: 'Whether the repo is private' },
      },
      required: ['owner', 'name', 'isPrivate'],
    },
  },
  {
    name: 'push_files',
    description: 'Push multiple files to a GitHub repository branch in a single atomic commit.',
    inputSchema: {
      properties: {
        owner: { type: 'string', description: 'GitHub username or org' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Target branch (e.g. "main")' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path (e.g. "src/App.tsx")' },
              content: { type: 'string', description: 'File content' },
            },
            required: ['path', 'content'],
          },
          description: 'Files to push',
        },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['owner', 'repo', 'branch', 'files', 'message'],
    },
  },
];

export interface ProtoToolDeps {
  createRepository(owner: string, name: string, isPrivate: boolean): Promise<{ url: string }>;
  pushFiles(owner: string, repo: string, branch: string, files: Array<{ path: string; content: string }>, message: string): Promise<void>;
}

export function createProtoToolHandlers(deps: ProtoToolDeps): ToolHandlerMap {
  return {
    create_repository: async (input) => {
      const { owner, name, isPrivate } = input as { owner: string; name: string; isPrivate: boolean };
      const result = await deps.createRepository(owner, name, isPrivate);
      return { success: true, url: result.url };
    },
    push_files: async (input) => {
      const { owner, repo, branch, files, message } = input as {
        owner: string; repo: string; branch: string;
        files: Array<{ path: string; content: string }>; message: string;
      };
      await deps.pushFiles(owner, repo, branch, files, message);
      return { success: true, filesCount: files.length };
    },
  };
}
