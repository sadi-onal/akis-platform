/**
 * GitHubMCPAdapter — bridges GitHubMCPService to the pipeline's GitHubServiceLike interface.
 * This allows the pipeline (Proto, Trace) to use real GitHub operations via the MCP Gateway.
 */
import type { GitHubServiceLike } from '../core/pipeline-factory.js';
import { logger } from '../../lib/logger.js';

export interface GitHubMCPAdapterDeps {
  callToolRaw<T>(toolName: string, args: Record<string, unknown>): Promise<T>;
}

// ─── AKIS Platform Repo Guard ────────────────────
const BLOCKED_PLATFORM_REPOS = ['akis-platform', 'akis-platform-development'];

function validateTargetRepo(repoFullName: string): void {
  const repoName = repoFullName.split('/').pop()?.toLowerCase() || '';
  if (BLOCKED_PLATFORM_REPOS.some((pattern) => repoName.includes(pattern))) {
    throw new Error(
      `Target repository "${repoFullName}" is the AKIS platform repo. ` +
        `Pipeline outputs must be pushed to a separate repository. ` +
        `Please specify a different target repository.`
    );
  }
}

/**
 * Adapter that wraps a GitHubMCPService (or anything with callToolRaw) into
 * the GitHubServiceLike interface used by the pipeline factory.
 */
export function createGitHubMCPAdapter(mcp: GitHubMCPAdapterDeps): GitHubServiceLike {
  return {
    async repoExists(owner: string, name: string): Promise<boolean> {
      // No dedicated "exists" tool on the GitHub MCP gateway — probe with
      // `get_file_contents` at the repo root. A successful (array) response
      // means the repo + main branch exist; "Not Found" / 404 errors mean it
      // doesn't. Any other error is propagated so the caller can decide.
      // Used by Proto's repo-name uniqueness guard (PR-V-duplicate-repo).
      try {
        await mcp.callToolRaw<unknown>('get_file_contents', {
          owner,
          repo: name,
          path: '',
        });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || /not\s*found/i.test(msg)) {
          return false;
        }
        throw err;
      }
    },

    async createRepository(
      owner: string,
      name: string,
      isPrivate: boolean
    ): Promise<{ url: string }> {
      validateTargetRepo(name);
      const result = await mcp.callToolRaw<{ html_url?: string; clone_url?: string }>(
        'create_repository',
        {
          name,
          description: `AKIS Pipeline scaffold — ${name}`,
          private: isPrivate,
          auto_init: true,
        }
      );
      const url = result.html_url || result.clone_url || `https://github.com/${owner}/${name}`;
      return { url };
    },

    async createBranch(
      owner: string,
      repo: string,
      branch: string,
      fromBranch?: string
    ): Promise<void> {
      await mcp.callToolRaw('create_branch', {
        owner,
        repo,
        branch,
        ...(fromBranch ? { from_branch: fromBranch } : {}),
      });
    },

    async commitFile(
      owner: string,
      repo: string,
      branch: string,
      filePath: string,
      content: string,
      message: string
    ): Promise<void> {
      await mcp.callToolRaw('create_or_update_file', {
        owner,
        repo,
        path: filePath,
        content,
        message,
        branch,
      });
    },

    async createPR(
      owner: string,
      repo: string,
      title: string,
      body: string,
      head: string,
      base: string
    ): Promise<{ url: string }> {
      const result = await mcp.callToolRaw<{ html_url?: string; number?: number }>(
        'create_pull_request',
        {
          owner,
          repo,
          title,
          body,
          head,
          base,
          draft: true,
        }
      );
      return { url: result.html_url || '' };
    },

    async listFiles(owner: string, repo: string, branch: string): Promise<string[]> {
      const files: string[] = [];
      const visited = new Set<string>();
      const MAX_DEPTH = 10;
      const MAX_FILES = 200;
      const EXCLUDE = [
        'node_modules/',
        '.git/',
        'dist/',
        'build/',
        '.next/',
        'coverage/',
        '.cache/',
        '__pycache__/',
      ];

      async function listDir(dirPath: string, depth: number): Promise<void> {
        if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
        if (visited.has(dirPath)) return;
        visited.add(dirPath);

        let result: unknown;
        try {
          result = await mcp.callToolRaw<unknown>('get_file_contents', {
            owner,
            repo,
            path: dirPath || '',
            branch,
          });
        } catch (err) {
          logger.warn(
            `[MCP listFiles] Failed to read dir "${dirPath}": ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }

        if (!Array.isArray(result)) return;

        for (const entry of result) {
          if (files.length >= MAX_FILES) break;
          if (!entry || typeof entry !== 'object') continue;
          const e = entry as Record<string, unknown>;
          const entryPath =
            typeof e.path === 'string' ? e.path : typeof e.name === 'string' ? e.name : '';
          const entryType = typeof e.type === 'string' ? e.type : '';
          if (!entryPath) continue;

          // Skip excluded directories (check nested paths too)
          if (EXCLUDE.some((p) => entryPath.includes(p) || entryPath === p.replace('/', ''))) {
            continue;
          }

          if (entryType === 'dir') {
            await listDir(entryPath, depth + 1);
          } else {
            files.push(entryPath);
          }
        }
      }

      await listDir('', 0);
      return files;
    },

    async getFileContent(
      owner: string,
      repo: string,
      branch: string,
      filePath: string
    ): Promise<string> {
      const result = await mcp.callToolRaw<unknown>('get_file_contents', {
        owner,
        repo,
        path: filePath,
        branch,
      });

      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return '';
      }

      const record = result as Record<string, unknown>;
      return typeof record.content === 'string' ? record.content : '';
    },
  };
}
