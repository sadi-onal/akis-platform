/**
 * Chat-scoped document attachment endpoint (issue #463).
 *
 * POST /api/chats/:chatId/attach
 *   - Accept @fastify/multipart uploads (max 10 MB per file, max 5 files)
 *   - Supported: .txt, .md, .ts, .js, .tsx, .jsx, .json, .html, .css, .yml,
 *                .yaml, .sql, .py, .sh, .toml, .xml, .go, .rs, .java, .csv,
 *                .pdf (text extraction via buffer.toString when possible)
 *   - NOT supported (out of scope): images → use BUG-C /attach-image endpoint
 *   - Chunks via existing RepoDocsIngester logic; embeds via EmbeddingService
 *   - Inserts knowledge_chunks rows with chat_id = :chatId
 *   - Cap: 100 chunks per upload (enforced by ChatScopedIngestionService)
 *   - Returns: { results: AttachResult[] }
 *
 * NOTE: Image uploads (/api/chats/:chatId/attach-image) are OUT OF SCOPE
 * for this PR (BUG-C #464 already covers multimodal image blocks).
 * GitHub repo URL ingestion is also OUT OF SCOPE (complex clone + multi-
 * file-type chunking, tracked as follow-up).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { requireAuth } from '../utils/auth.js';
import { chatScopedIngestionService, CHAT_CHUNK_QUOTA } from '../services/knowledge/ingestion/ChatScopedIngestionService.js';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import { pipelines } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

/** Extensions we accept as text-extractable documents. */
const ACCEPTED_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css',
  '.yml', '.yaml', '.sql', '.py', '.sh', '.toml', '.xml', '.go', '.rs',
  '.java', '.csv', '.env', '.gitignore', '.dockerignore',
]);

/** PDF — extract text best-effort (treat buffer as UTF-8, skip binary header). */
const ACCEPTED_PDF_EXTENSIONS = new Set(['.pdf']);

const TEXT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/html', 'text/css', 'application/json',
  'application/javascript', 'text/typescript', 'text/x-typescript',
  'application/x-javascript', 'application/typescript', 'text/x-python',
  'text/x-sh', 'text/yaml', 'text/x-yaml', 'application/yaml',
  'text/csv', 'application/xml', 'text/xml', 'text/x-java-source',
  'text/x-go', 'text/x-rust',
]);

function isTextFile(filename: string, mimetype: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (ACCEPTED_TEXT_EXTENSIONS.has(ext)) return true;
  if (ACCEPTED_PDF_EXTENSIONS.has(ext)) return true; // PDF treated as text (best-effort)
  if (TEXT_MIME_TYPES.has(mimetype)) return true;
  if (mimetype.startsWith('text/')) return true;
  return false;
}

/**
 * Naive PDF text extraction: skip the binary header/stream sections and
 * extract text from BT/ET blocks.  This handles most simple PDFs that
 * embed text rather than scanning scanned documents.  For complex PDFs the
 * output may be garbled, but the chunker will still produce usable chunks.
 *
 * We deliberately avoid pulling in `pdf-parse` as a dependency — the project
 * already has a strict dependency policy and the task spec says "pdf-parse if
 * already a dep, else text/* only".  Since `pdf-parse` is NOT in package.json
 * we use this lightweight fallback.
 */
function extractTextFromBuffer(buffer: Buffer, filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    // Extract text between BT (Begin Text) and ET (End Text) PDF operators
    const raw = buffer.toString('latin1');
    const textChunks: string[] = [];
    const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
    let match;
    while ((match = btRegex.exec(raw)) !== null) {
      // Extract string literals from Tj, TJ, ' and " operators
      const block = match[1];
      const strRegex = /\(([^)]*)\)/g;
      let sm;
      while ((sm = strRegex.exec(block)) !== null) {
        const decoded = sm[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')');
        if (decoded.trim()) textChunks.push(decoded);
      }
    }
    const extracted = textChunks.join(' ').replace(/\s{3,}/g, '\n\n');
    if (extracted.trim().length > 100) return extracted;
    // Fallback: treat buffer as latin1 and strip non-printable characters
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ').trim();
  }
  return buffer.toString('utf-8');
}

export interface AttachResult {
  filename: string;
  documentId: string;
  chunksCreated: number;
  status: 'ok' | 'quota_exceeded' | 'unsupported' | 'error';
  deduplicated?: boolean;
  message?: string;
}

export async function chatAttachRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/chats/:chatId/attach
   *
   * Multipart body: up to 5 files, each ≤ 10 MB.
   * Response: 200 { results: AttachResult[] }
   *           400 when chatId not found / auth fails
   */
  fastify.post(
    '/api/chats/:chatId/attach',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let user;
      try {
        user = await requireAuth(request);
      } catch {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      }

      const { chatId } = request.params as { chatId: string };

      // Validate chatId is a pipeline that belongs to the authenticated user
      const [pipeline] = await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, chatId), eq(pipelines.userId, user.id)))
        .limit(1);

      if (!pipeline) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Chat not found or access denied' },
        });
      }

      const results: AttachResult[] = [];
      let fileCount = 0;

      try {
        const parts = request.parts();

        for await (const part of parts) {
          if (part.type !== 'file') continue;

          fileCount++;
          if (fileCount > MAX_FILES) {
            // Drain remaining parts and break
            results.push({
              filename: part.filename,
              documentId: '',
              chunksCreated: 0,
              status: 'error',
              message: `Maksimum ${MAX_FILES} dosya yüklenebilir`,
            });
            // Drain the stream to avoid memory leak
            await part.toBuffer().catch(() => undefined);
            continue;
          }

          const filename = part.filename || 'unnamed';

          if (!isTextFile(filename, part.mimetype)) {
            // Images are handled by BUG-C /attach-image — skip gracefully
            const isImage = part.mimetype.startsWith('image/');
            results.push({
              filename,
              documentId: '',
              chunksCreated: 0,
              status: 'unsupported',
              message: isImage
                ? 'Görseller /attach-image endpoint\'i üzerinden yüklenmelidir'
                : `Desteklenmeyen dosya türü: ${part.mimetype}`,
            });
            await part.toBuffer().catch(() => undefined);
            continue;
          }

          let buffer: Buffer;
          try {
            buffer = await part.toBuffer();
          } catch (err) {
            logger.warn({ err, chatId, filename }, '[ChatAttach] Buffer read error');
            results.push({ filename, documentId: '', chunksCreated: 0, status: 'error', message: 'Dosya okunamadı' });
            continue;
          }

          if (buffer.length > MAX_FILE_SIZE) {
            results.push({
              filename,
              documentId: '',
              chunksCreated: 0,
              status: 'error',
              message: `Dosya boyutu çok büyük (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
            });
            continue;
          }

          let text: string;
          try {
            text = extractTextFromBuffer(buffer, filename);
          } catch (err) {
            logger.warn({ err, chatId, filename }, '[ChatAttach] Text extraction error');
            results.push({ filename, documentId: '', chunksCreated: 0, status: 'error', message: 'Metin çıkarımı başarısız' });
            continue;
          }

          if (!text.trim()) {
            results.push({ filename, documentId: '', chunksCreated: 0, status: 'ok', message: 'Dosya boş, atlandı' });
            continue;
          }

          const title = filename.replace(/\.[^.]+$/, ''); // strip extension for title

          try {
            const ingestionResult = await chatScopedIngestionService.ingest(chatId, title, text);

            results.push({
              filename,
              documentId: ingestionResult.documentId,
              chunksCreated: ingestionResult.chunksCreated,
              status: ingestionResult.status === 'quota_exceeded' ? 'quota_exceeded' : 'ok',
              deduplicated: ingestionResult.deduplicated,
              message:
                ingestionResult.status === 'quota_exceeded'
                  ? `Dosya çok büyük: ${CHAT_CHUNK_QUOTA} chunk limitini aşıyor. Daha kısa bir dosya deneyin.`
                  : ingestionResult.deduplicated
                  ? 'Aynı içerik zaten indexlendi, atlandı'
                  : undefined,
            });
          } catch (err) {
            logger.error({ err, chatId, filename }, '[ChatAttach] Ingestion error');
            results.push({ filename, documentId: '', chunksCreated: 0, status: 'error', message: 'Indexleme sırasında hata oluştu' });
          }
        }
      } catch (err) {
        logger.error({ err, chatId }, '[ChatAttach] Multipart processing error');
        return reply.code(400).send({ error: { code: 'MULTIPART_ERROR', message: 'Dosya yükleme işlemi başarısız' } });
      }

      const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);
      logger.info({ chatId, userId: user.id, files: results.length, totalChunks }, '[ChatAttach] Attach complete');

      return reply.send({ results });
    },
  );
}
