import { eq, desc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db as defaultDb } from '../../../db/client.js';
import { chatRetrievalAnchors, type ChatRetrievalAnchor } from '../../../db/schema.js';
import type * as schema from '../../../db/schema.js';
import type { RetrievalResult } from './types.js';
import { logger } from '../../../lib/logger.js';

type DB = NodePgDatabase<typeof schema>;

/**
 * Chat-level retrieval anchor store (issue #439).
 *
 * An "anchor" is a knowledge chunk that has been surfaced to a chat at a
 * specific message turn. The service records each surfaced chunk so that:
 *   (a) subsequent messages in the same chat can dedupe (exclude chunks
 *       the user has already seen in recent turns) and
 *   (b) the UI can one day render citation chips that trace each assistant
 *       message back to the exact chunks it was grounded on (#439 follow-up).
 *
 * Chat = root pipeline id. Iteration children share the parent's chat id
 * via `resolveChatId(pipeline)`.
 *
 * The service is deliberately narrow — no retrieval logic, no LRU eviction,
 * no content hashing. It just persists anchors and exposes a windowed read.
 */

export interface ChatRetrievalAnchorRecord {
  chatId: string;
  messageIndex: number;
  chunkId: string;
  documentId: string;
  score: number;
  retrievalMethod: string;
  createdAt: Date;
}

export interface PipelineChatIdentity {
  id: string;
  intermediateState?: Record<string, unknown> | null | undefined;
}

/**
 * Resolve the chat id for a pipeline. Iteration children point back to the
 * parent via `intermediateState.parentPipelineId` (issue #388 / BUG-08), so
 * the root pipeline id is the correct scope for RAG memory — anchors written
 * on turn N (parent) must be visible on turn N+1 (an iteration child).
 */
export function resolveChatId(pipeline: PipelineChatIdentity): string {
  const parent = pipeline.intermediateState?.parentPipelineId;
  return typeof parent === 'string' && parent.length > 0 ? parent : pipeline.id;
}

export class ChatRetrievalAnchorService {
  constructor(private readonly db: DB = defaultDb as unknown as DB) {}

  /**
   * Return the most-recent N anchors for a chat (default window = 10).
   * Ordered newest-first so callers can extract a bounded exclude-list
   * without paginating the whole chat history.
   */
  async read(chatId: string, opts: { windowSize?: number } = {}): Promise<ChatRetrievalAnchorRecord[]> {
    const windowSize = Math.max(1, Math.floor(opts.windowSize ?? 10));
    const rows = await this.db
      .select({
        chatId: chatRetrievalAnchors.chatId,
        messageIndex: chatRetrievalAnchors.messageIndex,
        chunkId: chatRetrievalAnchors.chunkId,
        documentId: chatRetrievalAnchors.documentId,
        score: chatRetrievalAnchors.score,
        retrievalMethod: chatRetrievalAnchors.retrievalMethod,
        createdAt: chatRetrievalAnchors.createdAt,
      })
      .from(chatRetrievalAnchors)
      .where(eq(chatRetrievalAnchors.chatId, chatId))
      .orderBy(desc(chatRetrievalAnchors.messageIndex), desc(chatRetrievalAnchors.createdAt))
      .limit(windowSize * 10);
    // Trim to distinct chunkIds, preserving order, capped at windowSize*4
    // so a single bursty retrieval doesn't starve the exclude set.
    const seen = new Set<string>();
    const trimmed: ChatRetrievalAnchorRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.chunkId)) continue;
      seen.add(row.chunkId);
      trimmed.push(row);
      if (trimmed.length >= windowSize * 4) break;
    }
    return trimmed;
  }

  /**
   * Persist a batch of retrieval hits as anchors for a chat at a given
   * message turn. Uses UPSERT semantics — re-surfacing an existing chunk
   * updates its score / message_index / method rather than duplicating
   * the anchor row.
   */
  async write(
    chatId: string,
    messageIndex: number,
    snippets: readonly RetrievalResult[],
  ): Promise<void> {
    if (snippets.length === 0) return;
    const now = new Date();
    const rows = snippets.map((s) => ({
      chatId,
      chunkId: s.chunkId,
      documentId: s.documentId,
      messageIndex,
      score: s.score,
      retrievalMethod: s.retrievalMethod ?? 'hybrid',
      createdAt: now,
    }));
    try {
      await this.db
        .insert(chatRetrievalAnchors)
        .values(rows)
        .onConflictDoUpdate({
          target: [chatRetrievalAnchors.chatId, chatRetrievalAnchors.chunkId],
          set: {
            messageIndex: sql`EXCLUDED.message_index`,
            score: sql`EXCLUDED.score`,
            retrievalMethod: sql`EXCLUDED.retrieval_method`,
          },
        });
    } catch (err) {
      // Non-fatal: retrieval already succeeded, we just failed to cache
      // the anchors for future dedup. Log and move on so the user's
      // current turn isn't blocked by a secondary write.
      logger.warn({ err, chatId, messageIndex, count: rows.length }, '[ChatRetrievalAnchor] upsert failed (non-fatal)');
    }
  }

  /** Test helper — remove all anchors for a chat. */
  async clear(chatId: string): Promise<void> {
    await this.db
      .delete(chatRetrievalAnchors)
      .where(eq(chatRetrievalAnchors.chatId, chatId));
  }

  /** Test helper — list every anchor for a chat without window trimming. */
  async readAll(chatId: string): Promise<ChatRetrievalAnchor[]> {
    return this.db
      .select()
      .from(chatRetrievalAnchors)
      .where(eq(chatRetrievalAnchors.chatId, chatId))
      .orderBy(desc(chatRetrievalAnchors.messageIndex));
  }

}

/** Singleton so callers don't re-instantiate the service per request. */
export const chatRetrievalAnchorService = new ChatRetrievalAnchorService();
