/**
 * Knowledge Documents API — manage user documents and RAG search.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeDocuments, knowledgeChunks } from '../db/schema.js';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { RepoDocsIngester } from '../services/knowledge/ingestion/RepoDocsIngester.js';
import { knowledgeRetrievalService } from '../services/knowledge/retrieval/KnowledgeRetrievalService.js';
import { requireAuth } from '../utils/auth.js';

const UploadDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(10).max(500000),
  agentType: z.enum(['scribe', 'proto', 'trace']).optional(),
});

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(1000),
  maxResults: z.coerce.number().min(1).max(50).optional().default(10),
  agentType: z.string().optional(),
  projectId: z.string().uuid().optional(),
  mode: z.enum(['keyword', 'hybrid']).optional().default('hybrid'),
});

export async function knowledgeRoutes(app: FastifyInstance) {
  // List user's documents
  app.get('/api/knowledge/documents', { preHandler: requireAuth }, async (request) => {
    const userId = (request as unknown as { userId: string }).userId;

    const docs = await db
      .select({
        id: knowledgeDocuments.id,
        title: knowledgeDocuments.title,
        docType: knowledgeDocuments.docType,
        agentType: knowledgeDocuments.agentType,
        status: knowledgeDocuments.status,
        projectId: knowledgeDocuments.projectId,
        createdAt: knowledgeDocuments.createdAt,
        updatedAt: knowledgeDocuments.updatedAt,
        metadata: knowledgeDocuments.metadata,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.workspaceId, userId))
      .orderBy(desc(knowledgeDocuments.updatedAt))
      .limit(100);

    return { documents: docs };
  });

  // Upload manual document
  app.post('/api/knowledge/documents', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as unknown as { userId: string }).userId;
    const body = UploadDocumentSchema.parse(request.body);

    const ingester = new RepoDocsIngester();
    const result = await ingester.ingestManualDocument({
      title: body.title,
      content: body.content,
      workspaceId: userId,
      agentType: body.agentType,
      status: 'proposed',
    });

    if (!result) {
      return reply.code(400).send({ error: 'Doküman oluşturulamadı' });
    }

    return { document: result };
  });

  // Delete document
  app.route({
    method: 'DELETE',
    url: '/api/knowledge/documents/:id',
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const userId = (request as unknown as { userId: string }).userId;
      const { id } = request.params as { id: string };

      const [doc] = await db
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.workspaceId, userId)))
        .limit(1);

      if (!doc) {
        return reply.code(404).send({ error: 'Doküman bulunamadı' });
      }

      await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, id));
      await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));

      return { ok: true };
    },
  });

  // Approve document
  app.post('/api/knowledge/documents/:id/approve', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as unknown as { userId: string }).userId;
    const { id } = request.params as { id: string };

    const result = await db
      .update(knowledgeDocuments)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.workspaceId, userId)))
      .returning({ id: knowledgeDocuments.id });

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Doküman bulunamadı' });
    }

    return { ok: true };
  });

  // Hybrid search
  app.get('/api/knowledge/search', { preHandler: requireAuth }, async (request) => {
    const userId = (request as unknown as { userId: string }).userId;
    const query = SearchQuerySchema.parse(request.query);

    const results = query.mode === 'hybrid'
      ? await knowledgeRetrievalService.searchHybrid(query.q, {
          maxResults: query.maxResults,
          filters: { workspaceId: userId, agentType: query.agentType, projectId: query.projectId },
        })
      : await knowledgeRetrievalService.search(query.q, {
          maxResults: query.maxResults,
          filters: { workspaceId: userId, agentType: query.agentType, projectId: query.projectId },
        });

    return { results, total: results.length };
  });

  // KB statistics
  app.get('/api/knowledge/stats', { preHandler: requireAuth }, async (request) => {
    const userId = (request as unknown as { userId: string }).userId;

    const [docCount] = await db
      .select({ count: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.workspaceId, userId));

    const [chunkCount] = await db
      .select({ count: count() })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
      .where(eq(knowledgeDocuments.workspaceId, userId));

    const [embeddedCount] = await db
      .select({ count: count() })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
      .where(and(
        eq(knowledgeDocuments.workspaceId, userId),
        sql`${knowledgeChunks.embedding} IS NOT NULL`,
      ));

    const byStatus = await db
      .select({ status: knowledgeDocuments.status, count: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.workspaceId, userId))
      .groupBy(knowledgeDocuments.status);

    const byAgent = await db
      .select({ agentType: knowledgeDocuments.agentType, count: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.workspaceId, userId))
      .groupBy(knowledgeDocuments.agentType);

    return {
      totalDocuments: docCount?.count ?? 0,
      totalChunks: chunkCount?.count ?? 0,
      embeddedChunks: embeddedCount?.count ?? 0,
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
      byAgent: Object.fromEntries(byAgent.map(r => [r.agentType ?? 'unknown', r.count])),
    };
  });
}
