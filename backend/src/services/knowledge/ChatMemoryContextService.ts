/**
 * Chat-level conversation memory assembly for pipeline agents (issue #462).
 *
 * Given a pipeline + a user turn query, this service:
 *   1. Resolves the chat id (parent pipeline for iteration children).
 *   2. Pulls recent conversation turns and trims them to a character budget
 *      so the LIFO-newest-first window survives the token cap.
 *   3. Calls `retrieveWithAnchors` — dedup'd RAG hits for this chat.
 *   4. Formats both as a single `## Conversation so far` / `## Retrieved
 *      context` block that downstream agents can prepend to their existing
 *      `knowledgeContext` string.
 *
 * Behaviour-preserving by default:
 *   - If the caller passes `enabled: false`, the service returns an empty
 *     string (zero injection, zero DB calls).
 *   - If DB calls fail the service logs + swallows, returning whatever
 *     partial block it could build. The agent turn must not be blocked by
 *     secondary reads.
 *
 * The resulting block is intentionally *plain text* — agents wrap it into
 * their cacheable system prompt via the existing `knowledgeContext` field
 * plumbing (ScribeAgent.ts:444, ProtoAgent.ts:613, TraceAgent.ts:585).
 */

import type { ScribeMessageType } from '../../pipeline/core/contracts/PipelineTypes.js';
import {
  knowledgeRetrievalService,
  type KnowledgeRetrievalService,
} from './retrieval/KnowledgeRetrievalService.js';
import {
  chatRetrievalAnchorService,
  resolveChatId,
  type ChatRetrievalAnchorService,
  type PipelineChatIdentity,
} from './retrieval/ChatRetrievalAnchorService.js';
import type { RetrievalResult, RetrievalFilter } from './retrieval/types.js';
import { logger } from '../../lib/logger.js';

/** ~4 chars per token (Anthropic heuristic, matches ContextAssemblyService). */
const CHARS_PER_TOKEN = 4;

/** Upper bound for a single rendered conversation turn (chars). Prevents one giant paste from evicting every other turn. */
const MAX_TURN_CHARS = 2_400;

/** Default token budget if caller doesn't override. Matches issue #462 acceptance criterion. */
const DEFAULT_MAX_TOKENS = 8_000;

/** Defensive upper bound on retrieved chunks (keeps block from exploding). */
const DEFAULT_RETRIEVAL_TOP_K = 5;

export interface ChatMemoryBuildOptions {
  /** Feature-flag wrapper. If `false`, the service returns '' without hitting any service. */
  enabled: boolean;
  /** The user's current-turn input — used as the retrieval query. */
  query: string;
  /** Token budget for the whole "Conversation so far" + "Retrieved context" block. */
  maxTokens?: number;
  /** Number of dedup'd chunks to request from `retrieveWithAnchors`. */
  maxResults?: number;
  /** Pass through to anchor lookup — controls dedup window. */
  windowSize?: number;
  /** Retrieval filter (workspaceId / projectId / etc.) — optional. */
  retrievalFilters?: RetrievalFilter;
  /**
   * Message index to write anchors under. Omit to skip anchor writeback
   * (pure read path — useful for retry scenarios where the "turn" has
   * already been recorded).
   */
  messageIndex?: number;
}

export interface ChatMemoryResult {
  /** Rendered block to splice into the agent's `knowledgeContext`. Empty string when flag is off or nothing usable was found. */
  block: string;
  /** Raw chunk results (for observability / test assertions). */
  retrievedChunks: RetrievalResult[];
  /** Chat id this memory was scoped to. Empty when flag is off. */
  chatId: string;
  /** Character length of the emitted block (`block.length`). */
  charCount: number;
}

/**
 * Subset of PipelineState this service actually reads. Keeps the interface
 * easy to mock in unit tests without constructing a full PipelineState.
 */
export interface ChatMemoryPipelineInput extends PipelineChatIdentity {
  scribeConversation?: readonly ScribeMessageType[];
}

export class ChatMemoryContextService {
  constructor(
    private readonly retrieval: KnowledgeRetrievalService = knowledgeRetrievalService,
    private readonly anchors: ChatRetrievalAnchorService = chatRetrievalAnchorService,
  ) {}

  /**
   * Build the chat-memory + retrieval block for a pipeline turn. Fails
   * soft — errors are logged and an empty block is returned rather than
   * letting a secondary service kill the agent call.
   */
  async build(pipeline: ChatMemoryPipelineInput, options: ChatMemoryBuildOptions): Promise<ChatMemoryResult> {
    if (!options.enabled) {
      return { block: '', retrievedChunks: [], chatId: '', charCount: 0 };
    }

    const chatId = resolveChatId(pipeline);
    const maxTokens = Math.max(256, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    // Split the char budget between conversation history (~70%) and
    // retrieval (~30%). Conversation is the authoritative memory signal —
    // retrieval is supplementary. Empirically 3/4 of information gain
    // comes from the prior turns in the same thread.
    const historyBudget = Math.floor(maxChars * 0.7);
    const retrievalBudget = Math.max(0, maxChars - historyBudget);

    const historyBlock = this.formatConversationHistory(pipeline.scribeConversation ?? [], historyBudget);

    let retrieved: RetrievalResult[] = [];
    try {
      retrieved = await this.retrieval.retrieveWithAnchors(options.query, {
        chatId,
        messageIndex: options.messageIndex,
        maxResults: options.maxResults ?? DEFAULT_RETRIEVAL_TOP_K,
        maxTokens: Math.max(1, Math.floor(retrievalBudget / CHARS_PER_TOKEN)),
        windowSize: options.windowSize,
        filters: options.retrievalFilters,
      });
    } catch (err) {
      logger.warn({ err, chatId }, '[ChatMemory] retrieveWithAnchors failed (non-fatal)');
    }

    const retrievalBlock = this.formatRetrievedChunks(retrieved, retrievalBudget);

    const parts: string[] = [];
    if (historyBlock) parts.push(historyBlock);
    if (retrievalBlock) parts.push(retrievalBlock);
    const block = parts.length > 0 ? parts.join('\n\n') + '\n' : '';

    return { block, retrievedChunks: retrieved, chatId, charCount: block.length };
  }

  /**
   * Render the conversation turns into a compact "## Conversation so far"
   * block. LIFO-newest-first so when we truncate to the character budget,
   * the most recent (and most load-bearing) turns are preserved.
   */
  formatConversationHistory(conversation: readonly ScribeMessageType[], maxChars: number): string {
    if (!conversation.length || maxChars <= 0) return '';

    // Walk newest → oldest, stop when adding the next turn would exceed budget.
    const rendered: string[] = [];
    let used = 0;

    // Budget header + trailing newline (cheap fixed cost).
    const header = '## Conversation so far\n';
    const footer = '\n--- END CONVERSATION ---';
    const overhead = header.length + footer.length + 2;
    const remaining = maxChars - overhead;
    if (remaining <= 0) return '';

    for (let i = conversation.length - 1; i >= 0; i--) {
      const turn = this.renderTurn(conversation[i], i + 1);
      if (!turn) continue;
      const trimmed = turn.length > MAX_TURN_CHARS
        ? `${turn.slice(0, MAX_TURN_CHARS)}\n… [truncated]`
        : turn;
      const cost = trimmed.length + 2; // '\n\n' separator

      // Stop if this turn would blow the budget. LIFO means older turns drop first.
      if (used + cost > remaining) {
        // Emit a breadcrumb so the model knows some turns were omitted.
        if (i > 0) rendered.push(`_[${i} earlier turn(s) omitted to fit ${maxChars}-char budget]_`);
        break;
      }

      rendered.push(trimmed);
      used += cost;
    }

    if (rendered.length === 0) return '';

    // We built in reverse; flip back to chronological order for readability.
    return header + rendered.reverse().join('\n\n') + footer;
  }

  /** Stable, short-form turn renderer. Long values are truncated by the caller. */
  private renderTurn(m: ScribeMessageType, idx: number): string {
    switch (m.type) {
      case 'user_idea':
        return `### [${idx}] User — initial idea\n${m.content.trim()}`;
      case 'user_answer':
        return `### [${idx}] User\n${m.content.trim()}`;
      case 'user_note':
        return `### [${idx}] User — note\n${m.content.trim()}`;
      case 'clarification': {
        const qs = m.content.questions.map((q) => `- ${q.question}`).join('\n');
        return `### [${idx}] Assistant — clarifying questions\n${qs}`;
      }
      case 'spec_draft':
        return `### [${idx}] Assistant — spec draft\nTitle: ${m.content.spec.title}`;
      case 'spec_approved':
        return `### [${idx}] Spec approved\nTitle: ${m.content.title}`;
      case 'spec_rejected':
        return `### [${idx}] User rejected spec\n${m.content.feedback.trim()}`;
      default: {
        // Exhaustiveness check — compile-time guarantee of full coverage.
        const _never: never = m;
        void _never;
        return '';
      }
    }
  }

  /**
   * Render dedup'd retrieval hits into a "## Retrieved context" block,
   * capped by `maxChars`. Hits that would overflow are dropped to keep
   * the prompt within budget.
   */
  formatRetrievedChunks(results: readonly RetrievalResult[], maxChars: number): string {
    if (!results.length || maxChars <= 0) return '';

    const header = '## Retrieved context\n';
    const footer = '\n--- END RETRIEVED CONTEXT ---';
    const overhead = header.length + footer.length + 2;
    let remaining = maxChars - overhead;
    if (remaining <= 0) return '';

    const rendered: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const provenance = r.provenance?.sourcePath
        ? `[${r.provenance.title}](${r.provenance.sourcePath})`
        : `[${r.provenance?.title ?? 'unknown source'}]`;
      const entry = `### Chunk ${i + 1}: ${provenance}\n${r.content}`;
      const cost = entry.length + 2;
      if (cost > remaining) break;
      rendered.push(entry);
      remaining -= cost;
    }

    if (rendered.length === 0) return '';
    return header + rendered.join('\n\n') + footer;
  }
}

/** Singleton so orchestrator call sites don't re-instantiate on every turn. */
export const chatMemoryContextService = new ChatMemoryContextService();

/**
 * Convenience helper used by orchestrator call sites. Returns the existing
 * `knowledgeContext` with the chat-memory block prepended, or the existing
 * context unchanged when the flag is off / nothing was assembled.
 *
 * Shape choice: we PREPEND the memory block so it sits at the start of the
 * cacheable prefix. The cache is content-hashed (issue #436), so keeping
 * the memory at a predictable position maximises prefix overlap across
 * turns.
 */
export async function withChatMemoryContext(
  pipeline: ChatMemoryPipelineInput,
  existingKnowledgeContext: string | undefined,
  options: ChatMemoryBuildOptions,
  service: ChatMemoryContextService = chatMemoryContextService,
): Promise<string | undefined> {
  const { block } = await service.build(pipeline, options);
  if (!block) return existingKnowledgeContext?.trim() ? existingKnowledgeContext : undefined;
  const base = existingKnowledgeContext?.trim() ? existingKnowledgeContext : '';
  const merged = base ? `${block}\n${base}` : block;
  return merged;
}
