/**
 * IntentClassifier — classifies a user message into one of 4 classes:
 * BUILD, ASK, FEEDBACK, CHAT (FR-11.1).
 *
 * Two execution paths:
 *  - mock provider → deterministic regex-based scorer (no AI cost; tests use this)
 *  - real provider → structured-JSON prompt against the AIService
 *
 * The classifier never persists raw message text. Only a SHA-256 hash, the
 * winning intent, confidence, alternates and a short reasoning sentence are
 * written to the `intent_classifications` table.
 *
 * Anchors:
 *  - 01-requirements FR-11.1..FR-11.4
 *  - 03-architecture § 3.1 (this file's location + interface) + § 4.3 (DB shape)
 *  - 06-roadmap Wave 4 PR 4.1
 *  - 05-findings F-10
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schemaNs from '../../../db/schema.js';
import { intentClassifications } from '../../../db/schema.js';
import type { AIServiceLike } from '../pipeline-factory.js';

export type IntentLabel = 'BUILD' | 'ASK' | 'FEEDBACK' | 'CHAT';

export interface IntentAlternate {
  intent: IntentLabel;
  confidence: number;
}

export interface IntentClassification {
  intent: IntentLabel;
  confidence: number; // 0..1
  reasoning: string; // short, for log
  alternates?: IntentAlternate[];
  /** DB row id (string-encoded bigint) — present when persistence succeeded. */
  classificationId?: string;
}

export interface IntentContext {
  pipelineId?: string;
  /** Last 5..10 messages, oldest → newest. Optional (FE caller decides). */
  recentMessages?: string[];
}

export interface IntentClassifierDeps {
  aiService: AIServiceLike;
  db: NodePgDatabase<typeof schemaNs>;
  logger: Logger;
  /** Provider id reported by AIService.getConfigSummary(). 'mock' switches to regex path. */
  provider: string;
  /** Confidence threshold below which the FE shows the disambiguation modal. */
  threshold?: number;
}

const VALID_INTENTS: readonly IntentLabel[] = ['BUILD', 'ASK', 'FEEDBACK', 'CHAT'] as const;

/**
 * Mock-provider regex scoring. Hand-tuned for Turkish + English signals so the
 * 4 most common cases (build/ask/feedback/chat) get high confidence on
 * unambiguous prompts and sub-0.7 on genuinely ambiguous one-word inputs.
 *
 * Each pattern contributes a fixed weight; a winner is normalised over the
 * total weight (or 0.5 if no pattern fires → falls into CHAT/disambiguation).
 */
const MOCK_PATTERNS: ReadonlyArray<{
  intent: IntentLabel;
  pattern: RegExp;
  weight: number;
}> = [
  // BUILD — imperative "do X / add X / build X"
  { intent: 'BUILD', pattern: /\b(yap(ar mısın|abilir misin)?|ekle|ekler misin|olsun|istiyorum|yaz(ar mısın)?|oluştur|kur)\b/i, weight: 1 },
  { intent: 'BUILD', pattern: /\b(build|create|add|make|implement|develop|set up|generate)\b/i, weight: 1 },
  // BUILD — feature-shaped nouns (sayfa/özellik/modal/...)
  { intent: 'BUILD', pattern: /\b(sayfa|özellik|modal|form|buton|ekran|api|endpoint)\b/i, weight: 0.4 },

  // ASK — explicit question signals
  { intent: 'ASK', pattern: /\?/, weight: 1 },
  { intent: 'ASK', pattern: /\b(nedir|nasıl|niye|neden|ne demek|açıkla|anlat)\b/i, weight: 1 },
  { intent: 'ASK', pattern: /\b(what|why|how|explain|describe|what's|whats)\b/i, weight: 0.8 },

  // FEEDBACK — bug / wrong-behaviour signals
  { intent: 'FEEDBACK', pattern: /\b(çalışmıyor|sorun|hata|yanlış|olmadı|kırık|patladı|bozuk)\b/i, weight: 1 },
  { intent: 'FEEDBACK', pattern: /\b(broken|bug|error|wrong|doesn'?t work|isn'?t working|failed|fails)\b/i, weight: 1 },
  { intent: 'FEEDBACK', pattern: /\b(beklediğim|beklemedim|olmamalıydı|silindi)\b/i, weight: 0.7 },

  // CHAT — greetings / smalltalk
  { intent: 'CHAT', pattern: /\b(merhaba|selam|hey|hi|hello|teşekkür|sağol|thanks?)\b/i, weight: 0.6 },
];

/** SHA-256 hex of a message (privacy: we never store the raw prose). */
export function hashMessage(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

/**
 * Pure scorer for mock provider. Exported so unit tests can call it directly
 * without DB / AIService plumbing.
 */
export function classifyByRegex(message: string): {
  intent: IntentLabel;
  confidence: number;
  reasoning: string;
  alternates: IntentAlternate[];
} {
  const scores: Record<IntentLabel, number> = { BUILD: 0, ASK: 0, FEEDBACK: 0, CHAT: 0 };
  const matched: Array<{ intent: IntentLabel; weight: number }> = [];

  for (const { intent, pattern, weight } of MOCK_PATTERNS) {
    if (pattern.test(message)) {
      scores[intent] += weight;
      matched.push({ intent, weight });
    }
  }

  // No signal at all → low-confidence CHAT (forces disambiguation modal for
  // genuinely ambiguous one-word inputs like "rapor").
  const total = scores.BUILD + scores.ASK + scores.FEEDBACK + scores.CHAT;
  if (total === 0) {
    return {
      intent: 'CHAT',
      confidence: 0.4,
      reasoning: 'Mock classifier: no signal matched; defaulting to CHAT with low confidence',
      alternates: [
        { intent: 'BUILD', confidence: 0.2 },
        { intent: 'ASK', confidence: 0.2 },
        { intent: 'FEEDBACK', confidence: 0.2 },
      ],
    };
  }

  // Winner = arg-max. Confidence = winner / total, capped at 0.97 to avoid
  // false certainty on a single-pattern hit.
  const ranked: IntentAlternate[] = VALID_INTENTS
    .map((intent) => ({ intent, confidence: scores[intent] / total }))
    .filter((x) => x.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  const winner = ranked[0];
  const confidence = Math.min(0.97, winner.confidence);

  return {
    intent: winner.intent,
    confidence,
    reasoning: `Mock classifier: matched ${matched.length} pattern(s); winner=${winner.intent}`,
    alternates: ranked.slice(1, 4),
  };
}

/** System prompt for the AI-mode classifier (real providers). */
const AI_SYSTEM_PROMPT = `You are an intent classifier for AKIS, an AI agent orchestration platform.

Classify each user message into exactly one of 4 classes:
  - BUILD     — user wants something built or added (imperative). Examples: "borç takibi sayfası ekle", "create a login form", "add export to PDF".
  - ASK       — user is asking a question. Examples: "rapor nedir?", "how does scribe work?", "what is a webhook?".
  - FEEDBACK  — user reports that something we built does not behave correctly. Examples: "müşteri silince eski borçlar da silindi", "the export button is broken", "this isn't working".
  - CHAT      — small talk, greetings, or none of the above. Examples: "merhaba", "thanks!", "great work".

Respond with ONLY a JSON object on a single line, no prose:
{"intent":"BUILD"|"ASK"|"FEEDBACK"|"CHAT","confidence":0.0..1.0,"reasoning":"≤140 chars","alternates":[{"intent":...,"confidence":...}]}

Confidence rubric:
  - 0.95+ — unambiguous, single clear signal (clear imperative, explicit question mark with question word, explicit bug report)
  - 0.80..0.94 — confident with mild ambiguity
  - 0.60..0.79 — best guess, alternates plausible
  - <0.60 — ambiguous; the FE should show a disambiguation modal

Always include 1..3 alternates ranked by their own confidence. Never echo the user's message back.`;

export class IntentClassifier {
  private readonly aiService: AIServiceLike;
  private readonly db: NodePgDatabase<typeof schemaNs>;
  private readonly logger: Logger;
  private readonly provider: string;
  private readonly threshold: number;

  constructor(deps: IntentClassifierDeps) {
    this.aiService = deps.aiService;
    this.db = deps.db;
    this.logger = deps.logger;
    this.provider = deps.provider;
    this.threshold = deps.threshold ?? 0.7;
  }

  /** Confidence threshold below which the FE should show disambiguation. */
  get disambiguationThreshold(): number {
    return this.threshold;
  }

  /**
   * Classify a single user message. Always persists the result (even on AI
   * failure, after falling back to regex) so the audit trail is complete.
   *
   * Returns the classification + the DB row id (so the caller can later issue
   * an `overrideClassification` if the user picks from the disambiguation
   * modal).
   */
  async classify(
    userId: string,
    message: string,
    ctx: IntentContext,
  ): Promise<IntentClassification> {
    let result: Omit<IntentClassification, 'classificationId'>;

    if (this.provider === 'mock') {
      result = classifyByRegex(message);
    } else {
      try {
        result = await this.classifyWithAI(message, ctx);
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[IntentClassifier] AI call failed, falling back to regex',
        );
        result = classifyByRegex(message);
      }
    }

    // Persist (privacy: hash, not raw message)
    let classificationId: string | undefined;
    try {
      const hash = hashMessage(message);
      const [row] = await this.db
        .insert(intentClassifications)
        .values({
          userId,
          pipelineId: ctx.pipelineId ?? null,
          messageHash: hash,
          intent: result.intent,
          // numeric(4,3) — drizzle expects a string
          confidence: result.confidence.toFixed(3),
          alternates: result.alternates ?? null,
        })
        .returning({ id: intentClassifications.id });
      classificationId = row?.id?.toString();
    } catch (err) {
      // Persistence failure shouldn't break the user-facing flow — log and
      // return the in-memory classification.
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[IntentClassifier] failed to persist classification',
      );
    }

    return { ...result, classificationId };
  }

  /**
   * User picked an option in the disambiguation modal. Stamps the chosen
   * intent into `override_intent` so we keep the original AI/regex pick and
   * the final user-confirmed pick side by side for analytics.
   */
  async overrideClassification(classificationId: string, intent: IntentLabel): Promise<void> {
    if (!VALID_INTENTS.includes(intent)) {
      throw new Error(`INVALID_INTENT: ${intent}`);
    }
    let id: bigint;
    try {
      id = BigInt(classificationId);
    } catch {
      throw new Error('INVALID_CLASSIFICATION_ID');
    }
    await this.db
      .update(intentClassifications)
      .set({ overrideIntent: intent })
      .where(eq(intentClassifications.id, id));
  }

  /**
   * Real-provider path — sends a structured-output prompt and parses the
   * JSON. Robust against provider chat-wrappers (we strip ```json fences and
   * leading prose) and validates the intent/confidence range before
   * returning. Any malformed response throws and the caller falls back to
   * regex.
   */
  private async classifyWithAI(
    message: string,
    ctx: IntentContext,
  ): Promise<Omit<IntentClassification, 'classificationId'>> {
    const recent = (ctx.recentMessages ?? []).slice(-8);
    const recentBlock = recent.length
      ? `Recent conversation (oldest → newest):\n${recent.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}\n\n`
      : '';

    const task = `${recentBlock}Current message:\n  ${message}\n\nReturn JSON.`;
    const out = await this.aiService.generateWorkArtifact({
      systemPrompt: AI_SYSTEM_PROMPT,
      task,
      maxTokens: 300,
    });

    const parsed = parseClassificationJson(out.content);
    if (!parsed) throw new Error('INTENT_AI_PARSE_FAILED');
    return parsed;
  }
}

/** Strips ```json fences and tries to extract a single JSON object. */
function parseClassificationJson(raw: string): Omit<IntentClassification, 'classificationId'> | null {
  if (!raw) return null;
  let body = raw.trim();
  // Strip code fences (```json … ``` or ``` … ```)
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  // If the model included prose before the JSON, grab the first {…} block.
  const objMatch = body.match(/\{[\s\S]*\}/);
  if (objMatch) body = objMatch[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const intent = typeof o.intent === 'string' ? o.intent.toUpperCase() : '';
  if (!VALID_INTENTS.includes(intent as IntentLabel)) return null;
  const confidence = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const reasoning = typeof o.reasoning === 'string' && o.reasoning.length > 0
    ? o.reasoning.slice(0, 280)
    : 'AI classifier';

  let alternates: IntentAlternate[] | undefined;
  if (Array.isArray(o.alternates)) {
    alternates = o.alternates
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        const ar = a as Record<string, unknown>;
        const i = typeof ar.intent === 'string' ? ar.intent.toUpperCase() : '';
        const c = typeof ar.confidence === 'number' ? ar.confidence : Number(ar.confidence);
        if (!VALID_INTENTS.includes(i as IntentLabel)) return null;
        if (!Number.isFinite(c) || c < 0 || c > 1) return null;
        return { intent: i as IntentLabel, confidence: c };
      })
      .filter((x): x is IntentAlternate => x !== null)
      .slice(0, 3);
  }

  return {
    intent: intent as IntentLabel,
    confidence,
    reasoning,
    alternates,
  };
}
