import { db } from '../../../db/client.js';
import { knowledgeDocuments, knowledgeChunks } from '../../../db/schema.js';
import { eq, and, ilike, desc, sql } from 'drizzle-orm';
import type { RetrievalResult, RetrievalOptions, RetrievalFilter } from './types.js';
import { getEmbeddingService } from '../../embedding/EmbeddingService.js';
import { logger } from '../../../lib/logger.js';

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_KEYWORD_WEIGHT = 0.55;
const DEFAULT_SEMANTIC_WEIGHT = 0.45;

export class KnowledgeRetrievalService {
  async search(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult[]> {
    return this.searchKeyword(query, options);
  }

  async searchHybrid(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult[]> {
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
    const semanticWeight = options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;

    const [keywordResults, semanticResults] = await Promise.all([
      this.searchKeyword(query, { ...options, maxResults: maxResults * 2, maxTokens: maxTokens * 2 }),
      this.searchSemantic(query, maxResults * 2, options.filters),
    ]);

    const merged = this.mergeHybridResults(
      keywordResults,
      semanticResults,
      keywordWeight,
      semanticWeight
    );

    return this.applyTokenBudget(merged, maxResults, maxTokens);
  }

  protected async searchKeyword(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult[]> {
    const {
      maxResults = DEFAULT_MAX_RESULTS,
      maxTokens = DEFAULT_MAX_TOKENS,
      filters = {},
      includeProposed = false,
    } = options;

    const conditions = [];

    if (filters.workspaceId) {
      conditions.push(eq(knowledgeDocuments.workspaceId, filters.workspaceId));
    }

    if (filters.projectId) {
      conditions.push(eq(knowledgeDocuments.projectId, filters.projectId));
    }

    if (filters.agentType) {
      conditions.push(eq(knowledgeDocuments.agentType, filters.agentType));
    }

    if (filters.docType) {
      conditions.push(eq(knowledgeDocuments.docType, filters.docType));
    }

    if (includeProposed) {
      conditions.push(
        sql`${knowledgeDocuments.status} IN ('approved', 'proposed')`
      );
    } else {
      conditions.push(eq(knowledgeDocuments.status, 'approved'));
    }

    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    
    if (keywords.length > 0) {
      const keywordConditions = keywords.map(keyword => 
        ilike(knowledgeChunks.content, `%${keyword}%`)
      );
      conditions.push(sql`(${sql.join(keywordConditions, sql` OR `)})`);
    }

    const results = await db
      .select({
        documentId: knowledgeDocuments.id,
        chunkId: knowledgeChunks.id,
        content: knowledgeChunks.content,
        tokenCount: knowledgeChunks.tokenCount,
        title: knowledgeDocuments.title,
        sourcePath: knowledgeDocuments.sourcePath,
        commitSha: knowledgeDocuments.commitSha,
        docType: knowledgeDocuments.docType,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
      .where(and(...conditions))
      .orderBy(desc(knowledgeDocuments.updatedAt))
      .limit(maxResults * 2);

    const scoredResults: RetrievalResult[] = results.map(row => {
      const contentLower = row.content.toLowerCase();
      const keywordMatches = keywords.filter(k => contentLower.includes(k)).length;
      const score = keywordMatches / Math.max(keywords.length, 1);

      return {
        documentId: row.documentId,
        chunkId: row.chunkId,
        content: row.content,
        score,
        keywordScore: score,
        semanticScore: 0,
        retrievalMethod: 'keyword',
        provenance: {
          title: row.title,
          sourcePath: row.sourcePath ?? undefined,
          commitSha: row.commitSha ?? undefined,
          docType: row.docType,
        },
      };
    });

    scoredResults.sort((a, b) => b.score - a.score);

    return this.applyTokenBudget(scoredResults, maxResults, maxTokens);
  }

  async getDocumentById(documentId: string) {
    const [doc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1);

    return doc ?? null;
  }

  async getChunksByDocumentId(documentId: string) {
    return db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, documentId))
      .orderBy(knowledgeChunks.chunkIndex);
  }

  protected async searchSemantic(query: string, maxResults: number, filters?: RetrievalFilter): Promise<RetrievalResult[]> {
    const embeddingService = getEmbeddingService();

    try {
      const queryEmbedding = await embeddingService.embed(query);
      const vectorStr = `[${queryEmbedding.join(',')}]`;

      // Build WHERE conditions using parameterized sql`` tagged template
      const conditions = [
        sql`d.status IN ('approved', 'proposed')`,
        sql`c.embedding IS NOT NULL`,
      ];

      if (filters?.workspaceId) {
        conditions.push(sql`d.workspace_id = ${filters.workspaceId}::uuid`);
      }
      if (filters?.projectId) {
        conditions.push(sql`d.project_id = ${filters.projectId}::uuid`);
      }
      if (filters?.agentType) {
        conditions.push(sql`d.agent_type = ${filters.agentType}`);
      }

      const whereClause = sql.join(conditions, sql` AND `);

      // pgvector cosine distance: <=> operator, similarity = 1 - distance
      // All interpolated values are parameterized via Drizzle's sql`` tagged template
      const results = await db.execute(sql`
        SELECT c.id AS chunk_id, c.content, c.document_id, d.title, d.source_path, d.doc_type,
               1 - (c.embedding <=> ${vectorStr}::vector) AS similarity
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON c.document_id = d.id
        WHERE ${whereClause}
        ORDER BY c.embedding <=> ${vectorStr}::vector
        LIMIT ${maxResults}
      `);

      const rows = results.rows as Array<{
        chunk_id: string; content: string; document_id: string;
        title: string; source_path: string | null; doc_type: string; similarity: number;
      }>;

      return rows.map(row => ({
        documentId: row.document_id,
        chunkId: row.chunk_id,
        content: row.content,
        score: this.clampScore(row.similarity),
        keywordScore: 0,
        semanticScore: this.clampScore(row.similarity),
        retrievalMethod: 'semantic' as const,
        provenance: {
          title: row.title,
          sourcePath: row.source_path ?? undefined,
          docType: row.doc_type,
        },
      }));
    } catch (err) {
      logger.warn(`[KnowledgeRetrieval] Semantic search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private mergeHybridResults(
    keywordResults: RetrievalResult[],
    semanticResults: RetrievalResult[],
    keywordWeight: number,
    semanticWeight: number
  ): RetrievalResult[] {
    const map = new Map<string, RetrievalResult>();

    const upsert = (result: RetrievalResult, channel: 'keyword' | 'semantic') => {
      const key = this.normalizeForMerge(result.content);
      const existing = map.get(key);
      const nextKeyword = channel === 'keyword'
        ? result.keywordScore ?? result.score
        : existing?.keywordScore ?? 0;
      const nextSemantic = channel === 'semantic'
        ? result.semanticScore ?? result.score
        : existing?.semanticScore ?? 0;

      const fusedScore = this.computeFusedScore(
        nextKeyword,
        nextSemantic,
        keywordWeight,
        semanticWeight
      );

      const merged: RetrievalResult = {
        ...(existing ?? result),
        content: existing?.content ?? result.content,
        keywordScore: nextKeyword,
        semanticScore: nextSemantic,
        score: fusedScore,
        retrievalMethod:
          nextKeyword > 0 && nextSemantic > 0
            ? 'hybrid'
            : nextSemantic > 0
              ? 'semantic'
              : 'keyword',
      };

      if (!existing || result.score > existing.score) {
        merged.documentId = result.documentId;
        merged.chunkId = result.chunkId;
        merged.provenance = result.provenance;
      }

      map.set(key, merged);
    };

    for (const result of keywordResults) {
      upsert(result, 'keyword');
    }
    for (const result of semanticResults) {
      upsert(result, 'semantic');
    }

    return Array.from(map.values()).sort((a, b) => b.score - a.score);
  }

  private computeFusedScore(
    keywordScore: number,
    semanticScore: number,
    keywordWeight: number,
    semanticWeight: number
  ): number {
    const hasKeyword = keywordScore > 0;
    const hasSemantic = semanticScore > 0;
    const weightSum =
      (hasKeyword ? keywordWeight : 0) +
      (hasSemantic ? semanticWeight : 0);

    if (weightSum <= 0) {
      return 0;
    }

    const fused = ((keywordScore * keywordWeight) + (semanticScore * semanticWeight)) / weightSum;
    return Math.round(this.clampScore(fused) * 100) / 100;
  }

  private applyTokenBudget(
    results: RetrievalResult[],
    maxResults: number,
    maxTokens: number
  ): RetrievalResult[] {
    let totalTokens = 0;
    const budgetedResults: RetrievalResult[] = [];

    for (const result of results) {
      const tokenCount = Math.ceil(result.content.length / 4);
      if (totalTokens + tokenCount > maxTokens) break;
      if (budgetedResults.length >= maxResults) break;

      totalTokens += tokenCount;
      budgetedResults.push(result);
    }

    return budgetedResults;
  }

  private normalizeForMerge(content: string): string {
    return content.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private clampScore(score: number): number {
    if (!Number.isFinite(score)) return 0;
    if (score < 0) return 0;
    if (score > 1) return 1;
    return score;
  }

  private hashText(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }
}

export const knowledgeRetrievalService = new KnowledgeRetrievalService();
