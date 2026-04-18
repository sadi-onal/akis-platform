/**
 * GitHub Integration API routes.
 * Manages GitHub PAT connection, repo listing, and repo creation.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../utils/auth.js';
import { getGitHubToken as resolveGitHubToken } from '../services/auth/githubToken.js';

const GITHUB_API = 'https://api.github.com';

const ConnectSchema = z.object({
  token: z.string().min(1),
});

const CreateRepoSchema = z.object({
  name: z.string().min(1).max(100),
  isPrivate: z.boolean().default(true),
});

async function ghFetch<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }

  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// Re-export the unified resolver so existing call-sites (server.app.ts, pipeline factory)
// continue to work without changes. See services/auth/githubToken.ts for priority order.
export const getGitHubToken = resolveGitHubToken;

export async function githubRoutes(fastify: FastifyInstance) {
  const isDevMode = process.env.DEV_MODE === 'true';

  const authPreHandler = async (request: FastifyRequest) => {
    if (isDevMode) {
      const devUser = await db.query.users.findFirst({
        where: eq(users.status, 'active'),
      });
      if (devUser) {
        (request as unknown as Record<string, unknown>).__githubUserId = devUser.id;
        return;
      }
    }
    const user = await requireAuth(request);
    (request as unknown as Record<string, unknown>).__githubUserId = user.id;
  };

  const getUserId = (request: FastifyRequest): string =>
    (request as unknown as Record<string, unknown>).__githubUserId as string;

  // GET /api/github/status
  fastify.get('/status', { preHandler: authPreHandler }, async (request) => {
    const userId = getUserId(request);
    const token = await getGitHubToken(userId);

    if (!token) {
      return { connected: false };
    }

    try {
      const ghUser = await ghFetch<{ login: string; avatar_url: string }>(token, 'GET', '/user');
      return {
        connected: true,
        username: ghUser.login,
        avatarUrl: ghUser.avatar_url,
      };
    } catch {
      return { connected: false };
    }
  });

  // GET /api/github/repos
  fastify.get('/repos', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = getUserId(request);
    const token = await getGitHubToken(userId);

    if (!token) {
      return reply.code(403).send({ error: { code: 'GITHUB_NOT_CONNECTED', message: 'GitHub not connected' } });
    }

    try {
      const repos = await ghFetch<Array<{
        name: string;
        full_name: string;
        private: boolean;
        html_url: string;
        updated_at: string;
      }>>(token, 'GET', '/user/repos?sort=updated&per_page=30');

      return {
        repos: repos.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          url: r.html_url,
          updatedAt: r.updated_at,
        })),
      };
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'GITHUB_API_ERROR', message: err instanceof Error ? err.message : 'Failed to list repos' },
      });
    }
  });

  // POST /api/github/repos
  fastify.post('/repos', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = getUserId(request);
    const token = await getGitHubToken(userId);

    if (!token) {
      return reply.code(403).send({ error: { code: 'GITHUB_NOT_CONNECTED', message: 'GitHub not connected' } });
    }

    const body = CreateRepoSchema.parse(request.body);

    try {
      const repo = await ghFetch<{
        name: string;
        full_name: string;
        html_url: string;
        clone_url: string;
      }>(token, 'POST', '/user/repos', {
        name: body.name,
        private: body.isPrivate,
        auto_init: true,
      });

      return reply.code(201).send({
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
      });
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'GITHUB_API_ERROR', message: err instanceof Error ? err.message : 'Failed to create repo' },
      });
    }
  });

  // POST /api/github/connect
  fastify.post('/connect', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = getUserId(request);
    const body = ConnectSchema.parse(request.body);

    // Validate token by calling GitHub API
    try {
      const ghUser = await ghFetch<{ login: string; avatar_url: string }>(body.token, 'GET', '/user');

      await db
        .update(users)
        .set({
          githubToken: body.token,
          githubUsername: ghUser.login,
          githubAvatarUrl: ghUser.avatar_url,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return { connected: true, username: ghUser.login, avatarUrl: ghUser.avatar_url };
    } catch {
      return reply.code(400).send({
        error: { code: 'INVALID_TOKEN', message: 'Invalid GitHub token' },
      });
    }
  });

  // POST /api/github/disconnect
  fastify.post('/disconnect', { preHandler: authPreHandler }, async (request) => {
    const userId = getUserId(request);

    await db
      .update(users)
      .set({
        githubToken: null,
        githubUsername: null,
        githubAvatarUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return { connected: false };
  });

  // GET /api/github/repos/:owner/:repo/context — fetch repo analysis context
  fastify.get(
    '/repos/:owner/:repo/context',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const userId = getUserId(request);
      const token = await getGitHubToken(userId);

      if (!token) {
        return reply.code(403).send({ error: { code: 'GITHUB_NOT_CONNECTED', message: 'GitHub not connected' } });
      }

      const params = request.params as { owner: string; repo: string };
      const query = (request.query ?? {}) as { branch?: string };
      const { owner, repo } = params;
      const branch = query.branch ?? 'main';

      try {
        const { createGitHubRESTAdapter } = await import('../pipeline/adapters/GitHubRESTAdapter.js');
        const { RepoContextAgent } = await import('../pipeline/agents/repo-context/RepoContextAgent.js');

        const githubService = createGitHubRESTAdapter({ token });

        // Create agent with a lightweight AI stub (fallback only — no AI summary)
        const agent = new RepoContextAgent(
          {
            async generateText(_sys: string, _user: string): Promise<string> {
              // Lightweight fallback — returns empty JSON so the agent uses its detectTechStackFromFiles fallback
              return JSON.stringify({ summary: `${owner}/${repo} repository`, techStack: [] });
            },
          },
          {
            listFiles: (o: string, r: string, b: string) => githubService.listFiles(o, r, b),
            getFileContent: (o: string, r: string, b: string, f: string) => githubService.getFileContent(o, r, b, f),
          },
        );

        const context = await agent.fetchContext({ owner, repo, branch });
        return { context };
      } catch (err) {
        return reply.code(500).send({
          error: { code: 'REPO_CONTEXT_ERROR', message: err instanceof Error ? err.message : 'Failed to analyze repo' },
        });
      }
    },
  );
}
