/**
 * Unit tests for chat-level retrieval plumbing (issue #439).
 *
 *  - `resolveChatId` collapses iteration children onto their parent so
 *    anchors are shared across a chat.
 *  - `KnowledgeRetrievalService.retrieveWithAnchors` dedupes already-surfaced
 *    chunks, records fresh hits, and degrades to plain hybrid when chatId
 *    is omitted.
 *
 * The anchor service is stubbed in-memory so these tests don't need a real
 * Postgres connection — DB-dependent paths live in integration suite.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveChatId,
  ChatRetrievalAnchorService,
  type ChatRetrievalAnchorRecord,
} from '../../src/services/knowledge/retrieval/ChatRetrievalAnchorService.js';
import { KnowledgeRetrievalService } from '../../src/services/knowledge/retrieval/KnowledgeRetrievalService.js';
import type { RetrievalResult } from '../../src/services/knowledge/retrieval/types.js';

// ─── resolveChatId ────────────────────────────────────────────────

describe('resolveChatId', () => {
  it('returns the pipeline id when there is no parent', () => {
    assert.equal(
      resolveChatId({ id: 'pipe-1', intermediateState: null }),
      'pipe-1',
    );
  });

  it('returns the pipeline id when intermediateState is undefined', () => {
    assert.equal(
      resolveChatId({ id: 'pipe-1' }),
      'pipe-1',
    );
  });

  it('returns the parent pipeline id when iteration child', () => {
    assert.equal(
      resolveChatId({ id: 'child-7', intermediateState: { parentPipelineId: 'root-1' } }),
      'root-1',
    );
  });

  it('falls back to id when parentPipelineId is empty string', () => {
    assert.equal(
      resolveChatId({ id: 'pipe-1', intermediateState: { parentPipelineId: '' } }),
      'pipe-1',
    );
  });

  it('falls back to id when parentPipelineId is not a string', () => {
    assert.equal(
      resolveChatId({ id: 'pipe-1', intermediateState: { parentPipelineId: 42 as unknown as string } }),
      'pipe-1',
    );
  });
});

// ─── In-memory anchor stub ────────────────────────────────────────

type AnchorRow = ChatRetrievalAnchorRecord;

class StubAnchorService {
  readonly byChat = new Map<string, AnchorRow[]>();

  read(chatId: string, opts: { windowSize?: number } = {}): Promise<AnchorRow[]> {
    const rows = this.byChat.get(chatId) ?? [];
    const windowSize = Math.max(1, Math.floor(opts.windowSize ?? 10));
    const seen = new Set<string>();
    const out: AnchorRow[] = [];
    for (const row of [...rows].reverse()) {
      if (seen.has(row.chunkId)) continue;
      seen.add(row.chunkId);
      out.push(row);
      if (out.length >= windowSize * 4) break;
    }
    return Promise.resolve(out);
  }

  write(chatId: string, messageIndex: number, snippets: readonly RetrievalResult[]): Promise<void> {
    const existing = this.byChat.get(chatId) ?? [];
    const merged = [...existing];
    for (const s of snippets) {
      const idx = merged.findIndex((row) => row.chunkId === s.chunkId);
      const next: AnchorRow = {
        chatId,
        messageIndex,
        chunkId: s.chunkId,
        documentId: s.documentId,
        score: s.score,
        retrievalMethod: s.retrievalMethod ?? 'hybrid',
        createdAt: new Date(),
      };
      if (idx >= 0) merged[idx] = next;
      else merged.push(next);
    }
    this.byChat.set(chatId, merged);
    return Promise.resolve();
  }

  clear(chatId: string): Promise<void> {
    this.byChat.delete(chatId);
    return Promise.resolve();
  }

  readAll(): Promise<AnchorRow[]> {
    return Promise.resolve([]);
  }
}

function makeResult(chunkId: string, score = 0.9): RetrievalResult {
  return {
    documentId: `doc-${chunkId}`,
    chunkId,
    content: `content-${chunkId}`,
    score,
    retrievalMethod: 'hybrid',
    provenance: { title: `t-${chunkId}`, docType: 'repo_doc' },
  };
}

/** Subclass so tests can stub `searchHybrid` without spinning up Postgres. */
class TestableKnowledgeRetrievalService extends KnowledgeRetrievalService {
  public hybridCalls: Array<{ query: string; maxResults?: number }> = [];
  public hybridResponder: (query: string) => RetrievalResult[] = () => [];

  override searchHybrid(query: string, options: { maxResults?: number } = {}): Promise<RetrievalResult[]> {
    this.hybridCalls.push({ query, maxResults: options.maxResults });
    return Promise.resolve(this.hybridResponder(query));
  }
}

// ─── retrieveWithAnchors ──────────────────────────────────────────

describe('KnowledgeRetrievalService.retrieveWithAnchors', () => {
  let stub: StubAnchorService;
  let svc: TestableKnowledgeRetrievalService;

  beforeEach(() => {
    stub = new StubAnchorService();
    svc = new TestableKnowledgeRetrievalService(stub as unknown as ChatRetrievalAnchorService);
  });

  it('falls back to plain hybrid when chatId is absent', async () => {
    svc.hybridResponder = () => [makeResult('a'), makeResult('b')];
    const out = await svc.retrieveWithAnchors('react todo', { maxResults: 2 });
    assert.equal(out.length, 2);
    assert.equal(svc.hybridCalls.length, 1);
    assert.equal(svc.hybridCalls[0].maxResults, 2);
    // No chat id → no anchor write
    assert.equal(stub.byChat.size, 0);
  });

  it('enlarges the search pool ~3x when chat id is supplied', async () => {
    svc.hybridResponder = () => [makeResult('a'), makeResult('b'), makeResult('c')];
    await svc.retrieveWithAnchors('q', { chatId: 'chat-1', messageIndex: 0, maxResults: 5 });
    assert.equal(svc.hybridCalls.length, 1);
    assert.ok((svc.hybridCalls[0].maxResults ?? 0) >= 15, 'pool should be ≥3× target');
  });

  it('writes fresh hits back as anchors', async () => {
    svc.hybridResponder = () => [makeResult('a'), makeResult('b')];
    await svc.retrieveWithAnchors('q', { chatId: 'chat-1', messageIndex: 0, maxResults: 2 });
    const anchors = stub.byChat.get('chat-1') ?? [];
    assert.equal(anchors.length, 2);
    assert.deepEqual(anchors.map((a) => a.chunkId).sort(), ['a', 'b']);
  });

  it('excludes previously-surfaced chunks on the next turn', async () => {
    // Turn 0: surface a, b
    svc.hybridResponder = () => [makeResult('a'), makeResult('b'), makeResult('c')];
    const t0 = await svc.retrieveWithAnchors('q', { chatId: 'chat-2', messageIndex: 0, maxResults: 2 });
    assert.deepEqual(t0.map((r) => r.chunkId).sort(), ['a', 'b']);

    // Turn 1: same pool, expect to get c + maybe one from 3 new
    svc.hybridResponder = () => [makeResult('a'), makeResult('b'), makeResult('c'), makeResult('d')];
    const t1 = await svc.retrieveWithAnchors('q', { chatId: 'chat-2', messageIndex: 1, maxResults: 2 });
    const ids = t1.map((r) => r.chunkId);
    assert.ok(!ids.includes('a'), 'a was already surfaced, should not reappear');
    assert.ok(!ids.includes('b'), 'b was already surfaced, should not reappear');
    assert.deepEqual(ids.sort(), ['c', 'd']);
  });

  it('honours caller-supplied priorChunkIds on top of anchors', async () => {
    svc.hybridResponder = () => [makeResult('a'), makeResult('b'), makeResult('c')];
    const out = await svc.retrieveWithAnchors('q', {
      chatId: 'chat-3',
      messageIndex: 0,
      maxResults: 2,
      priorChunkIds: ['a'],
    });
    assert.ok(!out.some((r) => r.chunkId === 'a'));
    assert.deepEqual(out.map((r) => r.chunkId).sort(), ['b', 'c']);
  });

  it('handles empty result pool without throwing', async () => {
    svc.hybridResponder = () => [];
    const out = await svc.retrieveWithAnchors('q', { chatId: 'chat-empty', messageIndex: 0, maxResults: 2 });
    assert.equal(out.length, 0);
  });

  it('skips anchor write when messageIndex is absent', async () => {
    svc.hybridResponder = () => [makeResult('a')];
    await svc.retrieveWithAnchors('q', { chatId: 'chat-no-idx', maxResults: 1 });
    assert.equal(stub.byChat.get('chat-no-idx'), undefined);
  });

  it('degrades gracefully when anchor read throws', async () => {
    const broken = {
      read: async () => {
        throw new Error('db down');
      },
      write: async () => { /* ignore */ },
    };
    const resilientSvc = new TestableKnowledgeRetrievalService(broken as unknown as ChatRetrievalAnchorService);
    resilientSvc.hybridResponder = () => [makeResult('a'), makeResult('b')];
    const out = await resilientSvc.retrieveWithAnchors('q', { chatId: 'chat-x', messageIndex: 0, maxResults: 2 });
    assert.equal(out.length, 2);
  });
});
