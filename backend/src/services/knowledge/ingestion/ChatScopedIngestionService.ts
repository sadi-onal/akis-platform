/**
 * Chat-scoped knowledge ingestion (issue #463).
 *
 * Accepts raw text content (extracted from .txt / .md / .pdf files),
 * chunks it, embeds it, and writes `knowledge_chunks` rows with the
 * caller-supplied `chatId` so retrieval can filter by chat.
 *
 * NOTE: image uploads are out of scope for this service — they are handled
 * by the multimodal path (BUG-C #464) and do NOT need chunking/embedding.
 */
import { db } from '../../../db/client.js';
import { knowledgeDocuments, knowledgeChunks } from '../../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'crypto';
import { getEmbeddingService } from '../../embedding/EmbeddingService.js';
import { logger } from '../../../lib/logger.js';

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
/** Hard cap on chunks per single upload to prevent embedding cost blow-up. */
export const CHAT_CHUNK_QUOTA = 100;

export interface ChatAttachResult {
  documentId: string;
  title: string;
  chunksCreated: number;
  /** true when the same content hash was already indexed for this chat */
  deduplicated: boolean;
  status: 'ok' | 'quota_exceeded';
}

export class ChatScopedIngestionService {
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Identical chunking logic to RepoDocsIngester — paragraph-aware with overlap. */
  chunkContent(content: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      const end = Math.min(start + CHUNK_SIZE, content.length);
      let chunkEnd = end;

      if (end < content.length) {
        const lastNewline = content.lastIndexOf('\n', end);
        const lastPeriod = content.lastIndexOf('. ', end);
        const breakPoint = Math.max(lastNewline, lastPeriod);
        if (breakPoint > start + CHUNK_SIZE / 2) {
          chunkEnd = breakPoint + 1;
        }
      }

      chunks.push(content.slice(start, chunkEnd).trim());
      if (chunkEnd >= content.length) break;

      const nextStart = Math.max(chunkEnd - CHUNK_OVERLAP, 0);
      start = nextStart > start ? nextStart : chunkEnd;
    }

    return chunks.filter((c) => c.length > 0);
  }

  private contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Ingest a single text document into a chat's knowledge base.
   *
   * @param chatId  Root pipeline id (= "chat" in AKIS terminology)
   * @param title   Human-readable filename / title
   * @param content Extracted plain text
   */
  async ingest(
    chatId: string,
    title: string,
    content: string,
  ): Promise<ChatAttachResult> {
    const trimmed = content.trim();
    if (!trimmed) {
      return { documentId: '', title, chunksCreated: 0, deduplicated: false, status: 'ok' };
    }

    const hash = this.contentHash(trimmed);

    // Dedup: same chat + same content hash → skip re-embedding
    const existingRows = await db
      .select({ id: knowledgeDocuments.id, metadata: knowledgeDocuments.metadata })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.chatId, chatId),
          eq(knowledgeDocuments.status, 'approved'),
        ),
      )
      .limit(100);

    const dup = existingRows.find((r) => {
      const m = r.metadata as Record<string, unknown> | null;
      return m?.contentHash === hash;
    });

    if (dup) {
      logger.info({ chatId, documentId: dup.id }, '[ChatIngestion] Dedup: same content hash already indexed');
      return { documentId: dup.id, title, chunksCreated: 0, deduplicated: true, status: 'ok' };
    }

    const chunks = this.chunkContent(trimmed);

    if (chunks.length > CHAT_CHUNK_QUOTA) {
      logger.warn({ chatId, title, chunkCount: chunks.length }, '[ChatIngestion] Quota exceeded');
      return { documentId: '', title, chunksCreated: 0, deduplicated: false, status: 'quota_exceeded' };
    }

    // Insert document record with chatId
    const [newDoc] = await db
      .insert(knowledgeDocuments)
      .values({
        title: title.slice(0, 500),
        content: trimmed,
        docType: 'manual',
        chatId,
        status: 'approved', // chat-scoped docs are immediately approved — the user controls them
        metadata: { contentHash: hash, source: 'chat_attach' },
      })
      .returning();

    // Insert chunks (chatId is also on the chunk for direct filter without join)
    if (chunks.length > 0) {
      const chunkRows = chunks.map((chunkContent, index) => ({
        documentId: newDoc.id,
        chatId,
        chunkIndex: index,
        content: chunkContent,
        tokenCount: this.estimateTokens(chunkContent),
      }));

      const inserted = await db
        .insert(knowledgeChunks)
        .values(chunkRows)
        .returning({ id: knowledgeChunks.id });

      // Embed asynchronously (best-effort, non-blocking to caller)
      setImmediate(() => {
        void this.embedChunks(inserted.map((r) => r.id), chunks, chatId);
      });
    }

    logger.info({ chatId, documentId: newDoc.id, chunks: chunks.length }, '[ChatIngestion] Ingested');
    return { documentId: newDoc.id, title, chunksCreated: chunks.length, deduplicated: false, status: 'ok' };
  }

  private async embedChunks(chunkIds: string[], texts: string[], chatId: string): Promise<void> {
    const embeddingService = getEmbeddingService();
    try {
      const embeddings = await embeddingService.embedBatch(texts);
      for (let i = 0; i < chunkIds.length; i++) {
        await db
          .update(knowledgeChunks)
          .set({ embedding: embeddings[i] })
          .where(eq(knowledgeChunks.id, chunkIds[i]));
      }
      logger.info({ chatId, count: chunkIds.length }, '[ChatIngestion] Embedding complete');
    } catch (err) {
      logger.warn({ err, chatId }, '[ChatIngestion] Embedding failed (non-fatal)');
    }
  }

  /** Delete all knowledge chunks and their document records for a chat. */
  async deleteForChat(chatId: string): Promise<number> {
    const docs = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.chatId, chatId));

    if (docs.length === 0) return 0;

    // Chunks cascade via FK; delete documents directly
    for (const doc of docs) {
      await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id));
    }

    return docs.length;
  }
}

export const chatScopedIngestionService = new ChatScopedIngestionService();
