/**
 * ChatQAService — pipeline-free RAG-augmented Q&A for chat.
 *
 * Flow:
 *   1. If `pipelineId` provided, retrieve spec / proto / findings / regression
 *      blobs from the pipelines row (MVP: direct read; full Piri RAG retrieval
 *      is a follow-up — see PR description).
 *   2. Compose a system prompt that pins the assistant to "explain only — never
 *      build" mode.
 *   3. Stream the AI completion via `onChunk`.
 *   4. Heuristically classify whether the answer implies a build is needed
 *      (Turkish + English imperatives like "ekleyebilirim / I can add").
 *   5. Return `{ answer, citations, needsBuild }`.
 *
 * Anchors:
 *   - 01-requirements FR-10.1..FR-10.4
 *   - 03-architecture § 3.2 (this file's location + interface) + § 5.3 sequence
 *   - 02-ux storyboard 1.3 ("12 dosya çok mu az mı?")
 *   - 06-roadmap Wave 4 PR 4.2
 *   - 05-findings F-09
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schemaNs from '../../../db/schema.js';
import { pipelines } from '../../../db/schema.js';
import type { AIServiceLike } from '../pipeline-factory.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type CitationSource = 'spec' | 'proto' | 'findings' | 'regression';

export interface Citation {
  source: CitationSource;
  excerpt: string;
  /**
   * Stable lookup key for the FE — e.g. `spec:projectName`,
   * `proto:src/App.tsx`, `findings:F-09`. Optional; the FE renders a chip even
   * without one.
   */
  refKey?: string;
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface QAResponse {
  answer: string;
  citations: Citation[];
  /** True if the AI's reply implies "I could build that" — FE shows a CTA. */
  needsBuild?: boolean;
}

export interface ChatQADeps {
  aiService: AIServiceLike;
  /**
   * Optional RAG service. The current MVP reads spec/proto from the pipelines
   * row directly; a future iteration will plug in Piri RAG (`PiriRAGService`)
   * for embedding-based retrieval. Kept on the Deps for forward compat.
   */
  ragService?: {
    query?: (question: string, topK?: number) => Promise<{ sources: Array<{ content: string; source: string; score: number }> }>;
  };
  db: NodePgDatabase<typeof schemaNs>;
  logger: Logger;
  /**
   * Provider id (`mock` | `anthropic` | …). Mock providers get a deterministic
   * answer template so we don't hit AI cost in tests.
   */
  provider: string;
}

export interface AnswerOptions {
  pipelineId: string | null;
  userId: string;
  message: string;
  history?: ChatHistoryEntry[];
  /** Streaming callback — receives token chunks as they arrive. */
  onChunk?: (chunk: string) => void;
  /** Citation callback — fires for each citation extracted from the context. */
  onCitation?: (citation: Citation) => void;
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sen AKIS'in açıklayıcı asistanısın. Kullanıcının projesi hakkında soru sorulduğunda mevcut spec/kod/findings'e dayanarak Türkçe yanıt veriyorsun. Yeni özellik üretmiyorsun.

Kurallar:
- Yanıtlar kısa, net ve Türkçe olmalı (Bakkal dili: kullanıcı geliştirici değil).
- Spec/kod/findings'te bilgi yoksa "şu an bilgim yok" de — uydurma.
- Eğer kullanıcı bir özellik istiyorsa "bunu yeni bir build olarak ekleyebilirim, ister misin?" gibi bir cümleyle bitir; aksi halde sadece bilgi ver.
- Cevabını markdown formatla: **kalın**, kısa listeler, küçük kod blokları.
- Asla kod üretip dosyaya yazma adımı önerme — sen sadece anlatırsın.`;

// ─── Heuristic for needsBuild ──────────────────────────────────────────────

/**
 * Detects whether the assistant's answer implies "I could build that". Turkish
 * cues: "ekleyebilirim", "yapabilirim", "kodlayabilirim", "oluşturabilirim".
 * English cues: "I can add", "I could implement", "let me build".
 *
 * Pure / exported so unit tests can hit it directly.
 */
export function detectNeedsBuild(answer: string): boolean {
  const text = answer.toLowerCase();
  return (
    /\b(ekleyebilir(im|iz)|yapabilir(im|iz)|kodlayabilir(im|iz)|oluşturabilir(im|iz)|geliştirebilir(im|iz))\b/.test(text)
    || /\b(i can (add|build|implement|create)|i could (add|build|implement|create)|let me (add|build|implement|create))\b/.test(text)
    || /\bbunu (yeni bir )?(özellik|build) olarak\b/.test(text)
  );
}

// ─── Context loader ────────────────────────────────────────────────────────

interface PipelineContext {
  spec: unknown;
  protoOutput: unknown;
  metrics: unknown;
}

/**
 * Pull the pipeline blobs the assistant needs. Auth check is enforced upstream
 * (route-level requireAuth + ownership). On any error we return empty context;
 * the assistant degrades gracefully.
 */
async function loadPipelineContext(
  db: NodePgDatabase<typeof schemaNs>,
  pipelineId: string,
  userId: string,
  logger: Logger,
): Promise<PipelineContext | null> {
  try {
    const rows = await db
      .select({
        id: pipelines.id,
        userId: pipelines.userId,
        approvedSpec: pipelines.approvedSpec,
        scribeOutput: pipelines.scribeOutput,
        protoOutput: pipelines.protoOutput,
        metrics: pipelines.metrics,
      })
      .from(pipelines)
      .where(eq(pipelines.id, pipelineId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      logger.warn({ pipelineId }, '[ChatQA] pipeline not found');
      return null;
    }
    if (row.userId !== userId) {
      // Don't leak existence — caller treats null as "no context".
      logger.warn({ pipelineId, userId }, '[ChatQA] pipeline access denied');
      return null;
    }
    return {
      spec: row.approvedSpec ?? row.scribeOutput,
      protoOutput: row.protoOutput,
      metrics: row.metrics,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[ChatQA] failed to load pipeline context',
    );
    return null;
  }
}

// ─── Citation extraction ───────────────────────────────────────────────────

/**
 * Build a small citation set from raw pipeline blobs. We surface up to 4 chips
 * so the FE can render a tidy strip below the answer. Excerpts are short (≤
 * 240 chars) so the hash isn't dominated by giant JSON dumps.
 */
export function buildCitations(ctx: PipelineContext | null): Citation[] {
  if (!ctx) return [];
  const out: Citation[] = [];

  if (ctx.spec) {
    const spec = ctx.spec as Record<string, unknown>;
    const projectName = typeof spec.projectName === 'string' ? spec.projectName : undefined;
    const description = typeof spec.description === 'string' ? spec.description : undefined;
    if (projectName || description) {
      out.push({
        source: 'spec',
        refKey: projectName ? `spec:${projectName}` : 'spec:overview',
        excerpt: truncate(`${projectName ?? 'Spec'}${description ? ` — ${description}` : ''}`, 240),
      });
    }
    const ac = spec.acceptanceCriteria;
    if (Array.isArray(ac) && ac.length) {
      out.push({
        source: 'spec',
        refKey: 'spec:acceptance',
        excerpt: truncate(`Kabul kriterleri: ${ac.slice(0, 3).join(' · ')}`, 240),
      });
    }
  }

  if (ctx.protoOutput) {
    const proto = ctx.protoOutput as Record<string, unknown>;
    const files = (proto.files ?? proto.generatedFiles) as Array<{ filePath?: string }> | undefined;
    if (Array.isArray(files) && files.length) {
      const list = files
        .slice(0, 5)
        .map((f) => (typeof f?.filePath === 'string' ? f.filePath : null))
        .filter((p): p is string => !!p);
      if (list.length) {
        out.push({
          source: 'proto',
          refKey: 'proto:files',
          excerpt: truncate(`${files.length} dosya: ${list.join(', ')}`, 240),
        });
      }
    }
  }

  if (ctx.metrics) {
    const m = ctx.metrics as Record<string, unknown>;
    if (m.regression || m.regressionConfidence) {
      out.push({
        source: 'regression',
        refKey: 'regression:summary',
        excerpt: truncate(`Regresyon raporu: ${JSON.stringify(m.regression ?? m.regressionConfidence).slice(0, 200)}`, 240),
      });
    }
  }

  return out.slice(0, 4);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ─── Mock answer template ──────────────────────────────────────────────────

/**
 * Deterministic mock answer for the `mock` provider. Picks a Turkish reply
 * shape based on simple keyword cues so unit + integration tests get stable
 * output without burning AI credits.
 */
export function mockAnswer(message: string, ctx: PipelineContext | null): string {
  const m = message.toLowerCase();
  const projectName = (ctx?.spec as { projectName?: string } | undefined)?.projectName;
  const fileCount = ((ctx?.protoOutput as { files?: unknown[] } | undefined)?.files ?? []).length;

  if (/\bdosya\b|\bfile\b|\bkaç\b|\bcount\b/.test(m)) {
    return [
      'Şu anki proje çıktısında ' + (fileCount > 0 ? `**${fileCount} dosya** üretildi.` : 'henüz dosya üretilmedi.'),
      fileCount > 0
        ? 'Çoğunlukla `src/` altında bileşenler ve config dosyaları var.'
        : 'Önce spec onayını bekliyoruz; sonra Proto kodları yazacak.',
      'Detayları görmek istersen Akış sekmesinde `Proto` adımına bakabilirsin.',
    ].join('\n\n');
  }
  if (/\bnedir\b|\bnasıl\b|\bne demek\b|\bwhat\b|\bhow\b|\bexplain\b|\baçıkla\b|\banlat\b/.test(m)) {
    return [
      `**${projectName ?? 'Bu proje'}** hakkında kısaca:`,
      ctx?.spec
        ? 'Spec onaylandı; kabul kriterleri kayıtlı.'
        : 'Henüz onaylı bir spec yok — önce ne istediğini birlikte netleştiriyoruz.',
      'Daha fazla detay istersen sorunu biraz daraltabilir misin?',
    ].join('\n\n');
  }
  // Fallback — also includes a "needsBuild" signal so the heuristic test passes.
  return [
    'Bunu mevcut spec/kod içinde net göremiyorum.',
    'Eğer bu bir özellik olsun istiyorsan **bunu yeni bir build olarak ekleyebilirim**.',
  ].join('\n\n');
}

// ─── Service ───────────────────────────────────────────────────────────────

export class ChatQAService {
  private readonly aiService: AIServiceLike;
  private readonly db: NodePgDatabase<typeof schemaNs>;
  private readonly logger: Logger;
  private readonly provider: string;
  // RAG kept as an opt-in dep; used by `enrichContextWithRAG` once Piri RAG
  // is wired here in a follow-up PR.
  private readonly _ragService?: ChatQADeps['ragService'];

  constructor(deps: ChatQADeps) {
    this.aiService = deps.aiService;
    this.db = deps.db;
    this.logger = deps.logger;
    this.provider = deps.provider;
    this._ragService = deps.ragService;
  }

  /**
   * Answer a chat-mode question.
   *
   * Streaming model: the `onChunk` callback is invoked for each piece of the
   * answer (mock provider chunks the answer in word groups; real providers
   * will eventually plug in `messages.stream` once we ship streaming through
   * AIService). For now real providers produce a single chunk because
   * AIService doesn't expose a streaming interface — see PR description.
   */
  async answer(opts: AnswerOptions): Promise<QAResponse> {
    const { pipelineId, userId, message, history = [], onChunk, onCitation } = opts;

    // 1. Load context (best-effort).
    const ctx = pipelineId
      ? await loadPipelineContext(this.db, pipelineId, userId, this.logger)
      : null;

    // 2. Build citations + emit them ahead of the answer text so the FE can
    //    render the chip strip while the answer is still streaming.
    const citations = buildCitations(ctx);
    if (onCitation) {
      for (const c of citations) onCitation(c);
    }

    // 3. Produce the answer.
    let answer: string;
    if (this.provider === 'mock') {
      answer = mockAnswer(message, ctx);
      // Chunk the mock answer so SSE smoke tests see incremental events.
      if (onChunk) emitChunked(answer, onChunk);
    } else {
      answer = await this.callRealAI(message, history, ctx, onChunk);
    }

    // 4. Heuristic build classification.
    const needsBuild = detectNeedsBuild(answer);

    return { answer, citations, needsBuild };
  }

  private async callRealAI(
    message: string,
    history: ChatHistoryEntry[],
    ctx: PipelineContext | null,
    onChunk: ((chunk: string) => void) | undefined,
  ): Promise<string> {
    const contextBlock = renderContextBlock(ctx);
    const historyBlock = history
      .slice(-6)
      .map((h) => `${h.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${h.content}`)
      .join('\n');

    const task = [
      contextBlock ? `Proje bağlamı:\n${contextBlock}` : null,
      historyBlock ? `Önceki sohbet:\n${historyBlock}` : null,
      `Soru:\n${message}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const out = await this.aiService.generateWorkArtifact({
        systemPrompt: SYSTEM_PROMPT,
        task,
        maxTokens: 800,
      });
      const answer = out.content?.trim() ?? '';
      // No-stream fallback — emit the whole answer as one chunk so the FE has
      // something to render before `done`.
      if (onChunk && answer) onChunk(answer);
      return answer;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[ChatQA] AI call failed',
      );
      throw err;
    }
  }
}

function renderContextBlock(ctx: PipelineContext | null): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.spec) {
    parts.push(`SPEC:\n${truncate(JSON.stringify(ctx.spec), 1500)}`);
  }
  if (ctx.protoOutput) {
    parts.push(`PROTO_OUTPUT:\n${truncate(JSON.stringify(ctx.protoOutput), 1500)}`);
  }
  return parts.join('\n\n');
}

/**
 * Split text into ~3-word chunks and emit them via the callback. Used by the
 * mock path so SSE clients can observe progressive token events without a
 * real streaming provider.
 */
function emitChunked(text: string, onChunk: (chunk: string) => void): void {
  const words = text.split(/(\s+)/);
  let buf = '';
  let count = 0;
  for (const w of words) {
    buf += w;
    if (!/^\s+$/.test(w)) count += 1;
    if (count >= 3) {
      onChunk(buf);
      buf = '';
      count = 0;
    }
  }
  if (buf) onChunk(buf);
}
