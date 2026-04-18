/**
 * Unit tests for {@link ChatMemoryContextService} (issue #462).
 *
 * Covers:
 *   - Feature-flag gating (no DB calls when disabled)
 *   - Conversation windowing / LIFO truncation to 8K token budget
 *   - Retrieval block formatting + budget enforcement
 *   - Error resilience (retrieval failure → empty retrieved block, no throw)
 *   - `resolveChatId` delegation for iteration children
 *
 * Retrieval + anchor services are stubbed in-memory so this suite runs
 * offline (SKIP_DB_TESTS=true path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatMemoryContextService,
  withChatMemoryContext,
} from '../../src/services/knowledge/ChatMemoryContextService.js';
import type { KnowledgeRetrievalService } from '../../src/services/knowledge/retrieval/KnowledgeRetrievalService.js';
import type { ChatRetrievalAnchorService } from '../../src/services/knowledge/retrieval/ChatRetrievalAnchorService.js';
import type { RetrievalResult } from '../../src/services/knowledge/retrieval/types.js';
import type { ScribeMessageType } from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Stub retrieval service ───────────────────────────────────────

function makeResult(chunkId: string, content: string, score = 0.9): RetrievalResult {
  return {
    documentId: `doc-${chunkId}`,
    chunkId,
    content,
    score,
    retrievalMethod: 'hybrid',
    provenance: { title: `title-${chunkId}`, docType: 'repo_doc', sourcePath: `src/${chunkId}.ts` },
  };
}

class StubRetrieval {
  calls: Array<{ query: string; chatId?: string; maxResults?: number; maxTokens?: number; messageIndex?: number }> = [];
  /** Each call returns the next batch from `batches`; last batch repeats. */
  batches: RetrievalResult[][] = [];
  /** If set, `retrieveWithAnchors` throws with this message (exercises error path). */
  throwWith?: string;

  retrieveWithAnchors(
    query: string,
    options: { chatId?: string; maxResults?: number; maxTokens?: number; messageIndex?: number } = {},
  ): Promise<RetrievalResult[]> {
    this.calls.push({ query, ...options });
    if (this.throwWith) throw new Error(this.throwWith);
    const idx = Math.min(this.calls.length - 1, this.batches.length - 1);
    return Promise.resolve(this.batches[idx] ?? []);
  }
}

// Dummy anchor service — never read directly by the subject under test.
const NOOP_ANCHORS = {
  read: async () => [],
  write: async () => { /* ignore */ },
  clear: async () => { /* ignore */ },
  readAll: async () => [],
} as unknown as ChatRetrievalAnchorService;

function makeService(stub: StubRetrieval = new StubRetrieval()): {
  svc: ChatMemoryContextService;
  stub: StubRetrieval;
} {
  const svc = new ChatMemoryContextService(
    stub as unknown as KnowledgeRetrievalService,
    NOOP_ANCHORS,
  );
  return { svc, stub };
}

// ─── Kill switch ──────────────────────────────────────────────────

describe('ChatMemoryContextService — feature flag', () => {
  it('returns an empty block when enabled=false (zero DB calls)', async () => {
    const { svc, stub } = makeService();
    const result = await svc.build(
      { id: 'pipe-1', scribeConversation: [{ type: 'user_idea', content: 'React todo app' }] },
      { enabled: false, query: 'todo' },
    );
    assert.equal(result.block, '');
    assert.equal(result.chatId, '');
    assert.equal(result.charCount, 0);
    assert.equal(stub.calls.length, 0, 'retrieval should NOT be called when flag is off');
  });

  it('calls retrieval with resolved chat id when enabled=true', async () => {
    const { svc, stub } = makeService();
    stub.batches = [[makeResult('a', 'first chunk content')]];
    const out = await svc.build(
      { id: 'child-7', intermediateState: { parentPipelineId: 'root-1' } },
      { enabled: true, query: 'auth flow', messageIndex: 3 },
    );
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].chatId, 'root-1', 'iteration child collapses to parent');
    assert.equal(stub.calls[0].messageIndex, 3);
    assert.equal(out.chatId, 'root-1');
  });
});

// ─── Conversation rendering ───────────────────────────────────────

describe('ChatMemoryContextService — formatConversationHistory', () => {
  it('renders turns chronologically with section header', () => {
    const { svc } = makeService();
    const conversation: ScribeMessageType[] = [
      { type: 'user_idea', content: 'React todo app with Google Auth' },
      {
        type: 'clarification',
        content: {
          questions: [
            { id: 'q1', question: 'Hangi stack?', reason: 'Tech seçimi', suggestions: ['React', 'Vue'] },
          ],
        },
      },
      { type: 'user_answer', content: 'React + Vite olsun' },
    ];
    const block = svc.formatConversationHistory(conversation, 4_000);

    assert.ok(block.startsWith('## Conversation so far'));
    assert.ok(block.includes('React todo app with Google Auth'));
    assert.ok(block.includes('Hangi stack?'));
    assert.ok(block.includes('React + Vite olsun'));
    const ideaIdx = block.indexOf('React todo app');
    const answerIdx = block.indexOf('React + Vite olsun');
    assert.ok(ideaIdx < answerIdx, 'turns must be chronological (oldest → newest)');
    assert.ok(block.endsWith('--- END CONVERSATION ---'));
  });

  it('returns empty string when conversation is empty', () => {
    const { svc } = makeService();
    assert.equal(svc.formatConversationHistory([], 4_000), '');
  });

  it('returns empty string when budget is zero or negative', () => {
    const { svc } = makeService();
    const conv: ScribeMessageType[] = [{ type: 'user_idea', content: 'idea' }];
    assert.equal(svc.formatConversationHistory(conv, 0), '');
    assert.equal(svc.formatConversationHistory(conv, -10), '');
  });

  it('truncates oldest turns LIFO when budget is exceeded', () => {
    const { svc } = makeService();
    const conversation: ScribeMessageType[] = [];
    // 20 turns, each ~400 chars of content.
    for (let i = 0; i < 20; i++) {
      conversation.push({ type: 'user_answer', content: `turn-${i} ${'x'.repeat(400)}` });
    }
    const block = svc.formatConversationHistory(conversation, 2_000);

    // Must include at least one of the most recent turns.
    assert.ok(block.includes('turn-19'), 'newest turn must survive');

    // Oldest turns must have been dropped — we explicitly emit an
    // "earlier turn(s) omitted" breadcrumb when dropping.
    assert.ok(!block.includes('turn-0 '), 'oldest turn must be dropped');
    assert.ok(block.includes('earlier turn'), 'omission breadcrumb must be emitted');

    // Final block must not blow past budget (allow small overhead for header/footer).
    assert.ok(block.length <= 2_100, `block length ${block.length} exceeds 2100-char ceiling`);
  });

  it('renders every ScribeMessageType variant without throwing', () => {
    const { svc } = makeService();
    const conv: ScribeMessageType[] = [
      { type: 'user_idea', content: 'idea' },
      { type: 'user_answer', content: 'answer' },
      { type: 'user_note', content: 'note' },
      { type: 'clarification', content: { questions: [{ id: 'q', question: 'q?', reason: 'r' }] } },
      {
        type: 'spec_draft',
        content: {
          spec: {
            title: 'Title',
            problemStatement: 'problem',
            userStories: [],
            acceptanceCriteria: [],
            technicalConstraints: {},
            outOfScope: [],
          },
          rawMarkdown: '# Title',
          confidence: 0.9,
          clarificationsAsked: 0,
        },
      },
      {
        type: 'spec_approved',
        content: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
      },
      { type: 'spec_rejected', content: { feedback: 'too vague' } },
    ];
    const block = svc.formatConversationHistory(conv, 10_000);
    assert.ok(block.includes('initial idea'));
    assert.ok(block.includes('clarifying questions'));
    assert.ok(block.includes('spec draft'));
    assert.ok(block.includes('Spec approved'));
    assert.ok(block.includes('rejected spec'));
  });
});

// ─── Retrieval block ──────────────────────────────────────────────

describe('ChatMemoryContextService — formatRetrievedChunks', () => {
  it('renders chunks with provenance header', () => {
    const { svc } = makeService();
    const out = svc.formatRetrievedChunks(
      [makeResult('a', 'alpha content'), makeResult('b', 'beta content')],
      4_000,
    );
    assert.ok(out.startsWith('## Retrieved context'));
    assert.ok(out.includes('alpha content'));
    assert.ok(out.includes('beta content'));
    assert.ok(out.includes('title-a'));
    assert.ok(out.includes('src/a.ts'));
  });

  it('drops chunks that would overflow the budget', () => {
    const { svc } = makeService();
    const bigChunk = makeResult('big', 'x'.repeat(5_000));
    const smallChunk = makeResult('small', 'short');
    // 200-char budget → only header + "small" should fit.
    const out = svc.formatRetrievedChunks([bigChunk, smallChunk], 200);
    // Either empty (if header+footer exceed budget) or contains only "short".
    if (out) {
      assert.ok(!out.includes('x'.repeat(100)));
    }
  });

  it('returns empty string for empty input or zero budget', () => {
    const { svc } = makeService();
    assert.equal(svc.formatRetrievedChunks([], 1_000), '');
    assert.equal(svc.formatRetrievedChunks([makeResult('a', 'c')], 0), '');
  });
});

// ─── End-to-end build ─────────────────────────────────────────────

describe('ChatMemoryContextService — build (end-to-end)', () => {
  it('combines conversation + retrieval into a single block', async () => {
    const { svc, stub } = makeService();
    stub.batches = [[makeResult('anchor-1', 'relevant docs content')]];
    const out = await svc.build(
      {
        id: 'pipe-42',
        scribeConversation: [
          { type: 'user_idea', content: 'Auth redesign' },
          { type: 'user_answer', content: 'Use OAuth instead of basic' },
        ],
      },
      { enabled: true, query: 'oauth flow', messageIndex: 2, maxTokens: 4_000 },
    );
    assert.ok(out.block.includes('## Conversation so far'));
    assert.ok(out.block.includes('Auth redesign'));
    assert.ok(out.block.includes('## Retrieved context'));
    assert.ok(out.block.includes('relevant docs content'));
    assert.equal(out.retrievedChunks.length, 1);
    assert.equal(out.chatId, 'pipe-42');
    assert.ok(out.charCount > 0);
  });

  it('honours the 8K-token default budget (~32K chars ceiling)', async () => {
    const { svc, stub } = makeService();
    // Seed retrieval with a huge blob that would blow the budget.
    stub.batches = [[makeResult('huge', 'x'.repeat(80_000))]];
    const hugeConv: ScribeMessageType[] = [];
    for (let i = 0; i < 40; i++) {
      hugeConv.push({ type: 'user_answer', content: `${i} ${'y'.repeat(2_000)}` });
    }
    const out = await svc.build(
      { id: 'pipe-budget', scribeConversation: hugeConv },
      { enabled: true, query: 'test', messageIndex: 40 },
    );
    // 8K tokens * 4 chars/token = 32,000 ceiling. Allow a little overhead.
    assert.ok(out.block.length <= 33_000, `block length ${out.block.length} exceeded 8K token budget`);
  });

  it('survives retrieval failures without throwing', async () => {
    const { svc, stub } = makeService();
    stub.throwWith = 'db offline';
    const out = await svc.build(
      { id: 'pipe-err', scribeConversation: [{ type: 'user_idea', content: 'hello' }] },
      { enabled: true, query: 'hello', messageIndex: 0 },
    );
    // Conversation block still rendered; retrieval just absent.
    assert.ok(out.block.includes('## Conversation so far'));
    assert.equal(out.retrievedChunks.length, 0);
  });

  it('returns empty block when there is nothing to render', async () => {
    const { svc, stub } = makeService();
    stub.batches = [[]];
    const out = await svc.build(
      { id: 'pipe-empty', scribeConversation: [] },
      { enabled: true, query: 'nothing here', messageIndex: 0 },
    );
    assert.equal(out.block, '');
    assert.equal(out.charCount, 0);
  });
});

// ─── withChatMemoryContext helper ─────────────────────────────────

describe('withChatMemoryContext', () => {
  it('prepends memory block to existing knowledgeContext', async () => {
    const { svc, stub } = makeService();
    stub.batches = [[makeResult('a', 'RAG hit')]];
    const merged = await withChatMemoryContext(
      { id: 'pipe-x', scribeConversation: [{ type: 'user_idea', content: 'hi' }] },
      '## EXISTING UNIFIED CONTEXT\nrepo info here',
      { enabled: true, query: 'hi', messageIndex: 0 },
      svc,
    );
    assert.ok(merged);
    const memIdx = merged!.indexOf('## Conversation so far');
    const existingIdx = merged!.indexOf('## EXISTING UNIFIED CONTEXT');
    assert.ok(memIdx >= 0 && existingIdx >= 0);
    assert.ok(memIdx < existingIdx, 'chat memory must be PREPENDED to existing context');
  });

  it('returns existing context unchanged when flag is off', async () => {
    const { svc } = makeService();
    const existing = '## EXISTING CONTEXT';
    const out = await withChatMemoryContext(
      { id: 'pipe-off' },
      existing,
      { enabled: false, query: 'q' },
      svc,
    );
    assert.equal(out, existing);
  });

  it('returns undefined when there is no existing context and flag is off', async () => {
    const { svc } = makeService();
    const out = await withChatMemoryContext(
      { id: 'pipe-empty' },
      undefined,
      { enabled: false, query: 'q' },
      svc,
    );
    assert.equal(out, undefined);
  });

  it('returns the block alone when existing context is empty/whitespace', async () => {
    const { svc, stub } = makeService();
    stub.batches = [[makeResult('a', 'hit')]];
    const out = await withChatMemoryContext(
      { id: 'pipe-alone', scribeConversation: [{ type: 'user_idea', content: 'x' }] },
      '   \n  ',
      { enabled: true, query: 'x', messageIndex: 0 },
      svc,
    );
    assert.ok(out);
    assert.ok(out!.startsWith('## Conversation so far'));
    assert.ok(!out!.includes('   \n  '));
  });
});
