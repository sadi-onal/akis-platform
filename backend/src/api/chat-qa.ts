/**
 * /api/chat-qa/ask — pipeline-free RAG-augmented Q&A (FR-10).
 *
 * SSE event stream:
 *   - `event: chunk`     `data: { text }`              — token (or chunk-of-tokens)
 *   - `event: citation`  `data: { source, excerpt, refKey? }` — context source
 *   - `event: done`      `data: { answer, citations, needsBuild }` — final
 *   - `event: error`     `data: { code, message }`     — failure
 *
 * Auth: cookie-based (`requireAuth`). The `pipelineId`, when supplied, is
 * checked for ownership inside `ChatQAService.loadPipelineContext`.
 *
 * Anchors:
 *   - 01-requirements FR-10.1..FR-10.4 + FR-11.2 (ASK route)
 *   - 03-architecture § 3.2 + § 5.3 sequence
 *   - 06-roadmap Wave 4 PR 4.2
 *   - 05-findings F-09
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerResponse } from 'http';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../utils/auth.js';
import {
  ChatQAService,
  type ChatHistoryEntry,
  type Citation,
} from '../pipeline/core/chat-qa/ChatQAService.js';
import type { AIServiceLike } from '../pipeline/core/pipeline-factory.js';

export interface ChatQAPluginOptions {
  aiService: AIServiceLike;
  /** Provider id (anthropic | openai | mock) — controls AI vs mock template. */
  provider: string;
}

// ─── lightweight body validation ──────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isHistoryEntry(v: unknown): v is ChatHistoryEntry {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string';
}

// ─── SSE helpers ──────────────────────────────────────────────────────────

function writeEvent(res: ServerResponse, event: string, data: unknown): boolean {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Map a backend exception into a coarse client-safe category + a Bakkal-tone
 * Turkish message. We never put the raw `err.message` on the wire — it can
 * leak provider tokens, Postgres FATAL: lines, stack frame fragments, etc.
 *
 * The category lets the FE distinguish "we're rate-limited, try again soon"
 * from "the AI provider is having a moment" without seeing the gory details.
 */
export function sanitizeChatQAError(err: unknown): { code: string; clientMessage: string } {
  const raw = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (/\b401\b|unauthorized|forbidden|invalid api key|api key/.test(raw)) {
    return {
      code: 'CHAT_QA_AUTH',
      clientMessage: 'Şu an cevap üretemiyoruz, biraz sonra tekrar deneyin.',
    };
  }
  if (/\b429\b|rate ?limit|too many requests|quota/.test(raw)) {
    return {
      code: 'CHAT_QA_RATELIMIT',
      clientMessage: 'Çok yoğunluk var, birkaç saniye sonra tekrar deneyin.',
    };
  }
  return {
    code: 'CHAT_QA_FAILED',
    clientMessage: 'Şu an cevap üretemiyoruz, biraz sonra tekrar deneyin.',
  };
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export async function chatQARoutes(
  fastify: FastifyInstance,
  opts: ChatQAPluginOptions,
) {
  const service = new ChatQAService({
    aiService: opts.aiService,
    db,
    logger,
    provider: opts.provider,
  });

  fastify.post(
    '/api/chat-qa/ask',
    {
      schema: {
        description:
          'Pipeline-free Q&A: returns an SSE stream of {chunk, citation, done|error} events (FR-10.1..FR-10.4).',
        tags: ['chat-qa'],
        body: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 8000 },
            pipelineId: { type: 'string' },
            history: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['role', 'content'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string', maxLength: 8000 },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // ── auth (must complete before we hijack the response) ──────────
      let userId: string;
      try {
        const user = await requireAuth(request);
        userId = user.id;
      } catch (err) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }

      // ── body validation ────────────────────────────────────────────
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isString(body.message) || body.message.trim().length === 0) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'message is required' },
        });
      }
      const pipelineId = isString(body.pipelineId) ? body.pipelineId : null;
      const rawHistory = Array.isArray(body.history) ? body.history : [];
      const history: ChatHistoryEntry[] = rawHistory.filter(isHistoryEntry);

      // ── set up SSE ─────────────────────────────────────────────────
      const res = (reply as unknown as { raw: ServerResponse }).raw;
      const reqRaw = (request as unknown as { raw: { on: (e: string, cb: () => void) => void } }).raw;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      reqRaw.on('close', onClose);

      const safeWrite = (event: string, data: unknown) => {
        if (closed) return;
        try {
          writeEvent(res, event, data);
        } catch {
          closed = true;
        }
      };

      // Tell Fastify we're handling the response ourselves.
      reply.hijack();

      // ── run the answer ─────────────────────────────────────────────
      const seenCitations: Citation[] = [];
      try {
        const result = await service.answer({
          pipelineId,
          userId,
          message: body.message,
          history,
          onChunk: (text) => safeWrite('chunk', { text }),
          onCitation: (c) => {
            seenCitations.push(c);
            safeWrite('citation', c);
          },
        });
        // Final event — clients can build on this even if they missed chunks
        // (e.g. they connected late).
        safeWrite('done', {
          answer: result.answer,
          citations: result.citations.length ? result.citations : seenCitations,
          needsBuild: !!result.needsBuild,
        });
      } catch (err) {
        // Log the full server-side detail (provider error, DB error, etc.) but
        // never echo it to the client — it can leak provider tokens, Postgres
        // FATAL: messages, etc. The FE renders this via toast, so we serve a
        // single Bakkal-tone Turkish message with a coarse category code.
        const rawMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: rawMsg }, '[chat-qa] answer failed');
        const { code, clientMessage } = sanitizeChatQAError(err);
        safeWrite('error', { code, message: clientMessage });
      } finally {
        if (!closed) {
          try {
            res.end();
          } catch {
            /* already closed */
          }
        }
      }
    },
  );
}
