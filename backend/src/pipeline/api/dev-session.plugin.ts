/**
 * Dev Session Fastify plugin — mounts /api/pipelines/:id/dev/* routes.
 * Post-pipeline development chat with DevAgent.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerResponse } from 'http';
import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { devSessions, devMessages } from '../../db/schema.js';
import { DevAgent, type DevAIDeps } from '../agents/dev/DevAgent.js';
import { getFileTreeViaREST, pushChangesViaREST } from '../adapters/GitHubRESTAdapter.js';
import type { AIServiceLike } from '../core/pipeline-factory.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';
import type { FileChange, DevSessionContext, FileTreeNode } from '../../types/dev-session.js';

export interface DevSessionPluginOptions {
  aiService: AIServiceLike;
  githubToken: string | null;
  orchestrator: PipelineOrchestrator;
  requireAuth: (request: FastifyRequest) => Promise<{ id: string }>;
  devUserId?: string;
}

export async function devSessionPlugin(
  fastify: FastifyInstance,
  opts: DevSessionPluginOptions,
) {
  const { aiService, githubToken, orchestrator, requireAuth, devUserId } = opts;
  const isDevMode = process.env.DEV_MODE === 'true';

  // Auth preHandler
  const authPreHandler = async (request: FastifyRequest) => {
    if (isDevMode && devUserId) {
      (request as unknown as Record<string, unknown>).__pipelineUserId = devUserId;
      return;
    }
    const user = await requireAuth(request);
    (request as unknown as Record<string, unknown>).__pipelineUserId = user.id;
  };

  // Create DevAgent AI deps from AIServiceLike
  function createDevAIDeps(): DevAIDeps {
    return {
      async generateText(systemPrompt: string, userPrompt: string): Promise<string> {
        const result = await aiService.generateWorkArtifact({
          systemPrompt,
          task: userPrompt,
          maxTokens: 8192,
        });
        return result.content;
      },
    };
  }

  // ═══════════════════════════════════════════
  // POST /:id/dev/start — Start dev session
  // ═══════════════════════════════════════════
  fastify.post('/:id/dev/start', { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: pipelineId } = request.params as { id: string };

    // 1. Find pipeline via orchestrator (in-memory store)
    let pipeline;
    try {
      pipeline = await orchestrator.getStatus(pipelineId);
    } catch {
      return reply.code(404).send({ error: 'Pipeline not found' });
    }

    if (pipeline.stage !== 'completed' && pipeline.stage !== 'completed_partial') {
      return reply.code(400).send({ error: 'Pipeline must be completed to start dev mode' });
    }

    // 2. Check existing active session
    const existingSession = await db.query.devSessions.findFirst({
      where: and(
        eq(devSessions.pipelineId, pipelineId),
        eq(devSessions.status, 'active'),
      ),
    });

    if (existingSession) {
      const messages = await db.query.devMessages.findMany({
        where: eq(devMessages.sessionId, existingSession.id),
        orderBy: [asc(devMessages.createdAt)],
      });
      return reply.send({
        sessionId: existingSession.id,
        fileTree: existingSession.initialFileTree,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          fileChanges: m.fileChanges,
          changeStatus: m.changeStatus,
          createdAt: m.createdAt,
        })),
      });
    }

    // 3. Extract repo/branch/spec from pipeline state
    const protoOutput = pipeline.protoOutput as Record<string, unknown> | undefined;
    const scribeOutput = pipeline.scribeOutput as Record<string, unknown> | undefined;

    let repoOwner: string | undefined;
    let repoName: string | undefined;
    let branch: string | undefined;

    if (protoOutput) {
      const repoStr = protoOutput.repo as string | undefined;
      if (repoStr?.includes('/')) {
        [repoOwner, repoName] = repoStr.split('/');
      }
      branch = protoOutput.branch as string | undefined;
    }

    const spec = scribeOutput?.spec ?? pipeline.approvedSpec;

    if (!repoOwner || !repoName || !branch) {
      return reply.code(400).send({ error: 'Pipeline missing repo/branch info from Proto output' });
    }

    // 4. Fetch file tree from GitHub
    let fileTree: FileTreeNode[] = [];
    if (githubToken) {
      try {
        fileTree = await getFileTreeViaREST(githubToken, repoOwner, repoName, branch);
      } catch (err) {
        logger.error({ err }, 'Failed to fetch file tree');
      }
    }

    // 5. Create session
    const [session] = await db.insert(devSessions).values({
      pipelineId,
      repoOwner,
      repoName,
      branch,
      specSnapshot: spec,
      initialFileTree: fileTree,
      status: 'active',
    }).returning();

    return reply.send({
      sessionId: session.id,
      fileTree,
      messages: [],
    });
  });

  // ═══════════════════════════════════════════
  // POST /:id/dev/chat — Send chat message (SSE)
  // ═══════════════════════════════════════════
  fastify.post('/:id/dev/chat', { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: pipelineId } = request.params as { id: string };
    const { sessionId, message } = request.body as { sessionId: string; message: string };

    // 1. Find session
    const session = await db.query.devSessions.findFirst({
      where: and(
        eq(devSessions.id, sessionId),
        eq(devSessions.pipelineId, pipelineId),
        eq(devSessions.status, 'active'),
      ),
    });

    if (!session) return reply.code(404).send({ error: 'Dev session not found' });

    // 2. Save user message
    await db.insert(devMessages).values({
      sessionId,
      role: 'user',
      content: message,
    });

    // 3. Load chat history
    const history = await db.query.devMessages.findMany({
      where: eq(devMessages.sessionId, sessionId),
      orderBy: [asc(devMessages.createdAt)],
    });

    // 4. Refresh file tree
    let currentFileTree = session.initialFileTree as FileTreeNode[];
    if (githubToken) {
      try {
        currentFileTree = await getFileTreeViaREST(
          githubToken, session.repoOwner, session.repoName, session.branch,
        );
      } catch (err) {
        logger.warn({ err }, 'Could not refresh file tree, using cached');
      }
    }

    // 5. Build context
    const context: DevSessionContext = {
      spec: session.specSnapshot,
      repoOwner: session.repoOwner,
      repoName: session.repoName,
      branch: session.branch,
      fileTree: currentFileTree,
      chatHistory: history
        .filter((m) => m.id !== history[history.length - 1]?.id) // exclude the just-inserted user msg
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          fileChanges: m.fileChanges as FileChange[] | undefined,
        })),
    };

    // 6. SSE headers
    const raw = reply as unknown as { raw: ServerResponse };
    raw.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 7. Run DevAgent
    const devAgent = new DevAgent(createDevAIDeps());

    try {
      const result = await devAgent.run({
        userMessage: message,
        context,
      });

      // Send text response
      raw.raw.write(`data: ${JSON.stringify({ type: 'text', content: result.response })}\n\n`);

      // Send file changes
      if (result.fileChanges.length > 0) {
        raw.raw.write(`data: ${JSON.stringify({ type: 'file_changes', changes: result.fileChanges })}\n\n`);
      }

      // Save assistant message
      await db.insert(devMessages).values({
        sessionId,
        role: 'assistant',
        content: result.response,
        fileChanges: result.fileChanges.length > 0 ? result.fileChanges : null,
        changeStatus: result.fileChanges.length > 0 ? 'pending' : null,
      });

      raw.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err) {
      logger.error({ err }, 'DevAgent error');
      raw.raw.write(`data: ${JSON.stringify({ type: 'error', content: String(err) })}\n\n`);
    }

    raw.raw.end();
  });

  // ═══════════════════════════════════════════
  // POST /:id/dev/push — Push changes to GitHub
  // ═══════════════════════════════════════════
  fastify.post('/:id/dev/push', { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, messageId } = request.body as { sessionId: string; messageId: string };

    const msg = await db.query.devMessages.findFirst({
      where: and(
        eq(devMessages.id, messageId),
        eq(devMessages.sessionId, sessionId),
      ),
    });

    if (!msg) return reply.code(404).send({ error: 'Message not found' });
    if (!msg.fileChanges) return reply.code(400).send({ error: 'No file changes to push' });
    if (msg.changeStatus === 'pushed') return reply.code(409).send({ error: 'Already pushed' });
    if (msg.changeStatus === 'rejected') return reply.code(409).send({ error: 'Cannot push rejected changes' });

    const session = await db.query.devSessions.findFirst({
      where: eq(devSessions.id, sessionId),
    });
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    if (!githubToken) {
      return reply.code(400).send({ error: 'GitHub token not configured' });
    }

    const changes = msg.fileChanges as FileChange[];
    const commitMessage = `dev: ${changes.map((c) => `${c.action} ${c.path}`).join(', ')}`;

    try {
      const commitSha = await pushChangesViaREST(
        githubToken,
        session.repoOwner,
        session.repoName,
        session.branch,
        changes,
        commitMessage,
      );

      await db.transaction(async (tx) => {
        await tx.update(devMessages)
          .set({ changeStatus: 'pushed', commitSha })
          .where(eq(devMessages.id, messageId));

        await tx.update(devSessions)
          .set({ totalCommits: sql`total_commits + 1`, updatedAt: new Date() })
          .where(eq(devSessions.id, sessionId));
      });

      return reply.send({
        commitSha,
        commitUrl: `https://github.com/${session.repoOwner}/${session.repoName}/commit/${commitSha}`,
      });
    } catch (err) {
      logger.error({ err }, 'GitHub push error');
      return reply.code(500).send({ error: `Push failed: ${String(err)}` });
    }
  });

  // ═══════════════════════════════════════════
  // POST /:id/dev/reject — Reject changes
  // ═══════════════════════════════════════════
  fastify.post('/:id/dev/reject', { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, messageId } = request.body as { sessionId: string; messageId: string };

    await db.update(devMessages)
      .set({ changeStatus: 'rejected' })
      .where(and(
        eq(devMessages.id, messageId),
        eq(devMessages.sessionId, sessionId),
      ));

    return reply.send({ ok: true });
  });

  // ═══════════════════════════════════════════
  // GET /:id/dev/session — Get session info
  // ═══════════════════════════════════════════
  fastify.get('/:id/dev/session', { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: pipelineId } = request.params as { id: string };

    const session = await db.query.devSessions.findFirst({
      where: and(
        eq(devSessions.pipelineId, pipelineId),
        eq(devSessions.status, 'active'),
      ),
    });

    if (!session) return reply.code(404).send({ error: 'No active dev session' });

    const messages = await db.query.devMessages.findMany({
      where: eq(devMessages.sessionId, session.id),
      orderBy: [asc(devMessages.createdAt)],
    });

    return reply.send({
      session: {
        id: session.id,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        branch: session.branch,
        status: session.status,
        totalCommits: session.totalCommits,
        createdAt: session.createdAt,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        fileChanges: m.fileChanges,
        changeStatus: m.changeStatus,
        commitSha: m.commitSha,
        createdAt: m.createdAt,
      })),
    });
  });
}
