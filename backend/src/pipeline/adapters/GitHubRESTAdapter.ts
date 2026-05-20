/**
 * GitHubRESTAdapter — implements GitHubServiceLike using GitHub REST API v3 directly.
 * No MCP Gateway dependency. Uses GITHUB_TOKEN (Bearer) for authentication.
 *
 * Endpoints used:
 *   POST   /user/repos                                → createRepository
 *   GET    /repos/{owner}/{repo}/git/ref/heads/{base} → get SHA for createBranch
 *   POST   /repos/{owner}/{repo}/git/refs             → createBranch
 *   PUT    /repos/{owner}/{repo}/contents/{path}      → commitFile
 *   GET    /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 → listFiles
 *   GET    /repos/{owner}/{repo}/contents/{path}?ref={branch} → getFileContent
 *   POST   /repos/{owner}/{repo}/pulls                → createPR
 */
import type { GitHubServiceLike } from '../core/pipeline-factory.js';
import {
  GitHubRateLimitError,
  GitHubAPIError,
  GitHubTokenInvalidError,
} from '../core/contracts/PipelineErrors.js';
import { logger } from '../../lib/logger.js';

const GITHUB_API = 'https://api.github.com';

interface GitHubRESTAdapterOptions {
  token: string;
}

const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Polls GET /repos/{owner}/{repo}/git/ref/heads/{branch} until it returns 200
 * or the timeout is exceeded.  Needed because GitHub's auto_init commit can take
 * 1-3 seconds to become visible on the REST API after createRepository returns.
 *
 * Retry schedule (ms): 500, 1000, 1500, 1500, 1500  (≤ 6 s total)
 */
async function waitForBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  const delays = [500, 1000, 1500, 1500, 1500];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await ghFetch<{ object: { sha: string } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${branch}`
      );
      return; // branch is ready
    } catch (err) {
      const is404 = err instanceof GitHubAPIError && err.statusCode === 404;
      if (!is404 || attempt === delays.length - 1) throw err;
      logger.info(
        { repo: `${owner}/${repo}`, branch, attempt: attempt + 1 },
        '[github_rest_request] waitForBranch: 404 on ref — retrying after %dms',
        delays[attempt]
      );
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

async function ghFetch<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${GITHUB_API}${path}`;

  logger.debug({ method, path }, 'github_rest_request');

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ method, path, err: msg }, 'github_rest_fetch_error');
      throw err;
    }

    // PR-V-github-401-graceful: 401 on ANY GitHub endpoint means the
    // OAuth/PAT token is invalid or expired (GitHub revoked, user-side
    // revoked, token rotated). Surface a dedicated typed error so the
    // pipeline never retries — auth failures don't recover with backoff.
    // The orchestrator catches this class and (a) clears the stale token
    // from `github_integrations`, (b) returns a user-actionable error code
    // (GITHUB_TOKEN_INVALID) that the banner renders with a "reconnect"
    // CTA pointing at /settings?tab=integrations.
    if (res.status === 401) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        const json = JSON.parse(text);
        detail = json.message || text;
      } catch {
        detail = text;
      }
      logger.warn(
        { method, path, status: 401, body: text.slice(0, 200) },
        'github_rest_unauthorized'
      );
      throw new GitHubTokenInvalidError(
        `GitHub API ${method} ${path} → 401: ${detail || 'Bad credentials'}`
      );
    }

    // Rate limit: back off and retry
    if (res.status === 429 || res.status === 403) {
      const retryAfter = res.headers.get('retry-after');
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 429 || remaining === '0') {
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitSec = retryAfter ? Math.min(parseInt(retryAfter, 10), 60) : 10 * (attempt + 1);
          logger.warn(
            { method, path, status: res.status, attempt: attempt + 1, waitSec },
            'github_rest_rate_limited'
          );
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const bodySnippet = text.slice(0, 500);
      let detail = '';
      try {
        const json = JSON.parse(text);
        detail = json.message || text;
      } catch {
        detail = text;
      }
      logger.error(
        { method, path, status: res.status, body: bodySnippet },
        'github_rest_error_response'
      );
      throw new GitHubAPIError(
        `GitHub API ${method} ${path} → ${res.status}: ${detail}`,
        res.status
      );
    }

    if (res.status === 204) return {} as T;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const responseBody = await res.text().catch(() => '');
      logger.error(
        { method, path, status: res.status, contentType, body: responseBody.slice(0, 500) },
        'github_rest_unexpected_content_type'
      );
      throw new GitHubAPIError(
        `GitHub API ${method} ${path} → ${res.status}: Expected JSON, got Content-Type "${contentType}". Body: ${responseBody.slice(0, 200)}`,
        res.status
      );
    }

    logger.debug({ method, path, status: res.status }, 'github_rest_response_ok');
    return (await res.json()) as T;
  }

  // Rate limit exhausted — non-retryable so outer withRetry doesn't compound retries
  logger.error(
    { method, path, attempts: MAX_RATE_LIMIT_RETRIES + 1 },
    'github_rest_rate_limit_exhausted'
  );
  throw new GitHubRateLimitError(
    `GitHub API ${method} ${path} → rate limited after ${MAX_RATE_LIMIT_RETRIES + 1} attempts`
  );
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

export function createGitHubRESTAdapter(opts: GitHubRESTAdapterOptions): GitHubServiceLike {
  const { token } = opts;

  return {
    async repoExists(owner: string, name: string): Promise<boolean> {
      // GET /repos/{owner}/{repo} → 200 means exists, 404 means free.
      // Anything else (5xx, rate-limit) is surfaced so the caller can decide
      // whether to retry or fail open (treat as "exists" to be safe).
      try {
        await ghFetch<{ id: number }>(token, 'GET', `/repos/${owner}/${name}`);
        return true;
      } catch (err) {
        if (err instanceof GitHubAPIError && err.statusCode === 404) {
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
      let result: { html_url: string; full_name: string; owner?: { login: string } };
      try {
        result = await ghFetch<{ html_url: string; full_name: string; owner?: { login: string } }>(
          token,
          'POST',
          '/user/repos',
          {
            name,
            description: `AKIS Pipeline scaffold — ${name}`,
            private: isPrivate,
            auto_init: true,
          }
        );
      } catch (err) {
        // GitHub returns 404 on POST /user/repos when the OAuth token is
        // invalid or expired (the endpoint doesn't exist for that credential).
        // Surface a user-actionable error instead of a generic GITHUB_API_ERROR.
        if (err instanceof GitHubAPIError && err.statusCode === 404) {
          logger.warn(
            { owner, name, statusCode: 404 },
            '[GitHubRESTAdapter] createRepository: 404 on POST /user/repos — token likely invalid/expired'
          );
          throw new GitHubTokenInvalidError(
            'POST /user/repos returned 404 — OAuth token is invalid or expired'
          );
        }
        throw err;
      }
      // Layer A — Read-back verification (PR #477): confirm the repo is accessible
      // before declaring success. Protects against silent-failure cases where the POST
      // returns 201 but the repo is not yet visible (eventual consistency).
      const resolvedOwner = result.owner?.login ?? result.full_name?.split('/')[0] ?? owner;
      logger.info(
        { repo: result.full_name ?? `${resolvedOwner}/${name}`, url: result.html_url },
        '[GitHubRESTAdapter] createRepository: POST succeeded, verifying read-back'
      );
      await ghFetch<{ id: number }>(token, 'GET', `/repos/${resolvedOwner}/${name}`);
      logger.info(
        { repo: result.full_name ?? `${resolvedOwner}/${name}` },
        '[GitHubRESTAdapter] createRepository: read-back OK'
      );
      // Layer B — Wait for GitHub to provision the initial commit / main branch (#478).
      // Read-back above confirms the repo exists; this confirms the branch ref is usable
      // before pushFiles GETs it. Without this the immediate ref-fetch can 404.
      await waitForBranch(token, resolvedOwner, name, 'main');
      return { url: result.html_url };
    },

    async createBranch(
      owner: string,
      repo: string,
      branch: string,
      fromBranch?: string
    ): Promise<void> {
      const base = fromBranch || 'main';
      // Get the SHA of the base branch
      const ref = await ghFetch<{ object: { sha: string } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${base}`
      );
      // Create the new branch
      await ghFetch(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
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
      // Check if file exists to get its SHA (needed for updates)
      let existingSha: string | undefined;
      try {
        const existing = await ghFetch<{ sha: string }>(
          token,
          'GET',
          `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`
        );
        existingSha = existing.sha;
      } catch {
        // File doesn't exist — that's fine, we're creating it
      }

      await ghFetch(token, 'PUT', `/repos/${owner}/${repo}/contents/${filePath}`, {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
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
      const result = await ghFetch<{ html_url: string }>(
        token,
        'POST',
        `/repos/${owner}/${repo}/pulls`,
        { title, body, head, base, draft: true }
      );
      return { url: result.html_url };
    },

    async listFiles(owner: string, repo: string, branch: string): Promise<string[]> {
      // Get the tree recursively
      const tree = await ghFetch<{
        tree: Array<{ path: string; type: string }>;
        truncated: boolean;
      }>(token, 'GET', `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);

      return tree.tree
        .filter((item) => item.type === 'blob')
        .map((item) => item.path)
        .filter(
          (p) =>
            !p.includes('node_modules/') &&
            !p.includes('.git/') &&
            !p.includes('dist/') &&
            !p.includes('build/')
        );
    },

    async getFileContent(
      owner: string,
      repo: string,
      branch: string,
      filePath: string
    ): Promise<string> {
      const result = await ghFetch<{ content?: string; encoding?: string }>(
        token,
        'GET',
        `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`
      );

      if (result.content && result.encoding === 'base64') {
        return Buffer.from(result.content, 'base64').toString('utf-8');
      }

      return result.content || '';
    },

    async pushFiles(
      owner: string,
      repo: string,
      branch: string,
      files: Array<{ path: string; content: string }>,
      message: string
    ): Promise<void> {
      validateTargetRepo(`${owner}/${repo}`);

      // 1. Get latest commit SHA on branch.
      // Retry on 404: a freshly-created repo with auto_init may not have its
      // main branch visible on the REST API for 1-3 s after creation.
      const PUSH_REF_DELAYS = [500, 1000, 1500, 1500, 1500];
      let ref!: { object: { sha: string } };
      for (let attempt = 0; attempt < PUSH_REF_DELAYS.length; attempt++) {
        try {
          ref = await ghFetch<{ object: { sha: string } }>(
            token,
            'GET',
            `/repos/${owner}/${repo}/git/ref/heads/${branch}`
          );
          break;
        } catch (err) {
          const is404 = err instanceof GitHubAPIError && err.statusCode === 404;
          if (!is404 || attempt === PUSH_REF_DELAYS.length - 1) throw err;
          logger.info(
            { repo: `${owner}/${repo}`, branch, attempt: attempt + 1 },
            '[github_rest_request] pushFiles: 404 on ref — retrying after %dms',
            PUSH_REF_DELAYS[attempt]
          );
          await new Promise((r) => setTimeout(r, PUSH_REF_DELAYS[attempt]));
        }
      }
      const latestCommitSha = ref.object.sha;

      // 2. Get the tree SHA of that commit
      const commit = await ghFetch<{ tree: { sha: string } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`
      );
      const baseTreeSha = commit.tree.sha;

      // 3. Create blobs for each file
      const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const file of files) {
        const blob = await ghFetch<{ sha: string }>(
          token,
          'POST',
          `/repos/${owner}/${repo}/git/blobs`,
          { content: file.content, encoding: 'utf-8' }
        );
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      }

      // 4. Create tree
      const newTree = await ghFetch<{ sha: string }>(
        token,
        'POST',
        `/repos/${owner}/${repo}/git/trees`,
        { base_tree: baseTreeSha, tree }
      );

      // 5. Create commit
      const newCommit = await ghFetch<{ sha: string }>(
        token,
        'POST',
        `/repos/${owner}/${repo}/git/commits`,
        { message, tree: newTree.sha, parents: [latestCommitSha] }
      );

      // 6. Update branch ref
      await ghFetch(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        sha: newCommit.sha,
      });

      // 7. Post-push read-back: verify the commit SHA is now the branch tip.
      // This catches silent failures where the PATCH silently dropped due to
      // a transient 5xx that ghFetch retried past without surfacing the error.
      const updatedRef = await ghFetch<{ object: { sha: string } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${branch}`
      );
      if (updatedRef.object.sha !== newCommit.sha) {
        logger.error(
          { owner, repo, branch, expectedSha: newCommit.sha, actualSha: updatedRef.object.sha },
          '[GitHubRESTAdapter] pushFiles: branch tip SHA mismatch after push — commit did not land'
        );
        throw new GitHubAPIError(
          `pushFiles: branch "${branch}" tip is ${updatedRef.object.sha} but expected ${newCommit.sha} — files were not committed`
        );
      }
      logger.info(
        { owner, repo, branch, commitSha: newCommit.sha, fileCount: files.length },
        '[GitHubRESTAdapter] pushFiles: push verified OK'
      );
    },
  };
}

/**
 * Get the authenticated user's GitHub login name.
 */
export async function getGitHubOwnerViaREST(token: string): Promise<string> {
  const user = await ghFetch<{ login: string }>(token, 'GET', '/user');
  return user.login;
}

// ─── Dev Mode Extensions ──────────────────────────

import type { FileChange, FileTreeNode } from '../../types/dev-session.js';

/**
 * Fetch full file tree as structured FileTreeNode[] (for DevAgent context).
 */
export async function getFileTreeViaREST(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<FileTreeNode[]> {
  const tree = await ghFetch<{
    tree: Array<{ path: string; type: string; size?: number }>;
    truncated: boolean;
  }>(token, 'GET', `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);

  const flatFiles: Array<{ path: string; size?: number }> = tree.tree
    .filter((item) => item.type === 'blob')
    .filter(
      (item) =>
        !item.path.includes('node_modules/') &&
        !item.path.includes('.git/') &&
        !item.path.includes('dist/')
    )
    .map((item) => ({ path: item.path, size: item.size }));

  return buildTreeStructure(flatFiles);
}

function buildTreeStructure(flatFiles: Array<{ path: string; size?: number }>): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirs = new Map<string, FileTreeNode>();

  for (const file of flatFiles) {
    const parts = file.path.split('/');

    if (parts.length === 1) {
      root.push({ path: file.path, type: 'file', size: file.size });
    } else {
      let currentPath = '';
      let currentLevel = root;

      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

        if (!dirs.has(currentPath)) {
          const dir: FileTreeNode = { path: parts[i], type: 'dir', children: [] };
          dirs.set(currentPath, dir);
          currentLevel.push(dir);
        }

        currentLevel = dirs.get(currentPath)!.children!;
      }

      currentLevel.push({ path: parts[parts.length - 1], type: 'file', size: file.size });
    }
  }

  return root;
}

/**
 * Push multiple file changes as a single commit (tree API).
 * Used by DevAgent push flow.
 */
export async function pushChangesViaREST(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  changes: FileChange[],
  commitMessage: string
): Promise<string> {
  validateTargetRepo(`${owner}/${repo}`);

  // 1. Get latest commit SHA on branch
  const refData = await ghFetch<{ object: { sha: string } }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`
  );
  const latestCommitSha = refData.object.sha;

  // 2. Get the tree SHA from that commit
  const commitData = await ghFetch<{ tree: { sha: string } }>(
    token,
    'GET',
    `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`
  );
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for create/modify, collect tree items
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];

  for (const change of changes) {
    if (change.action === 'delete') {
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
    } else {
      const blob = await ghFetch<{ sha: string }>(
        token,
        'POST',
        `/repos/${owner}/${repo}/git/blobs`,
        { content: change.content || '', encoding: 'utf-8' }
      );
      treeItems.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
  }

  // 4. Create new tree
  const newTree = await ghFetch<{ sha: string }>(
    token,
    'POST',
    `/repos/${owner}/${repo}/git/trees`,
    { base_tree: baseTreeSha, tree: treeItems }
  );

  // 5. Create commit
  const newCommit = await ghFetch<{ sha: string }>(
    token,
    'POST',
    `/repos/${owner}/${repo}/git/commits`,
    { message: commitMessage, tree: newTree.sha, parents: [latestCommitSha] }
  );

  // 6. Update branch ref
  await ghFetch(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
  });

  return newCommit.sha;
}
