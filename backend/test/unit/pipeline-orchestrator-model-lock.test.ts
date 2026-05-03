import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import { PipelineOrchestrator, type PipelineStore } from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';

/**
 * PR-A Commit 5: model lock semantics for setModel.
 *
 * Pipelines created from PR-A onward stamp `modelLockedAt` at creation, so
 * `setModel` must throw 409. The only exception is migrated pre-PR-A
 * pipelines whose model was nulled by migration 0046 — they get exactly one
 * transitional set, which itself stamps the lock.
 */

const userId = 'user-1';
const pipelineId = 'pipe-1';

function makeMockStore(initial: Partial<PipelineState>): {
  store: PipelineStore;
  updates: Array<Partial<PipelineState>>;
} {
  const updates: Array<Partial<PipelineState>> = [];
  let state: PipelineState = {
    id: pipelineId,
    userId,
    stage: 'awaiting_approval',
    traceEnabled: false,
    scribeConversation: [],
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
    attemptCount: 0,
    stageVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  const store: PipelineStore = {
    create: async () => state,
    getById: async (id: string) => (id === pipelineId ? state : null),
    update: async (_id: string, data: Partial<PipelineState>) => {
      updates.push(data);
      state = { ...state, ...(data as PipelineState) };
      return state;
    },
    listByUser: async () => [],
    cancel: async () => state,
    listChildren: async () => [],
    listFailed: async () => [],
  } as unknown as PipelineStore;
  return { store, updates };
}

function makeOrchestrator(store: PipelineStore): PipelineOrchestrator {
  // Cast undefined deps — setModel only touches store.getById + store.update.
  return new PipelineOrchestrator(
    store,
    {} as never,
    {} as never,
    {} as never,
    async () => 'owner',
    async () => null,
    () => ({}) as never,
  );
}

describe('PipelineOrchestrator.setModel — model lock (PR-A Commit 5)', () => {
  it('rejects setModel on a locked pipeline with 409 MODEL_LOCKED', async () => {
    const { store } = makeMockStore({
      model: 'claude-haiku-4-5-20251001',
      modelLockedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const orch = makeOrchestrator(store);
    await assert.rejects(
      () => orch.setModel(pipelineId, userId, 'claude-sonnet-4-6'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { statusCode?: number }).statusCode, 409);
        assert.equal((err as Error & { code?: string }).code, 'MODEL_LOCKED');
        return true;
      },
    );
  });

  it('allows one transitional set on a migrated NULL-model pipeline and locks afterwards', async () => {
    const { store, updates } = makeMockStore({ model: undefined, modelLockedAt: undefined });
    const orch = makeOrchestrator(store);

    const result = await orch.setModel(pipelineId, userId, 'claude-sonnet-4-6');
    assert.equal(result.model, 'claude-sonnet-4-6');
    assert.ok(result.modelLockedAt instanceof Date, 'modelLockedAt should be stamped');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].model, 'claude-sonnet-4-6');
    assert.ok(updates[0].modelLockedAt instanceof Date);

    // Second call must fail — the first set locked it.
    await assert.rejects(
      () => orch.setModel(pipelineId, userId, 'claude-opus-4-7'),
      { message: /sabit/ },
    );
  });

  it('rejects when caller is not the owner (UNAUTHORIZED before lock check)', async () => {
    const { store } = makeMockStore({ model: 'claude-haiku-4-5-20251001' });
    const orch = makeOrchestrator(store);
    await assert.rejects(
      () => orch.setModel(pipelineId, 'someone-else', 'claude-sonnet-4-6'),
      { message: 'UNAUTHORIZED' },
    );
  });

  it('startPipeline stamps modelLockedAt on the FIRST store.update (source-of-truth invariant)', async () => {
    // The lock contract is: every chat is locked at creation, not just when
    // the user sets a model later via setModel. This test asserts the
    // invariant at the source rather than only testing the downstream guard.
    //
    // We don't run the full pipeline — Scribe / Proto / Trace are stubbed to
    // throw, so startPipeline aborts after persisting the initial state. We
    // only care about that first update.
    const { store, updates } = makeMockStore({});
    const orch = makeOrchestrator(store);

    try {
      await orch.startPipeline(userId, { idea: 'todo app', context: '', targetStack: 'react' } as never);
    } catch {
      // Expected — Scribe is a no-op stub. The lock stamp lives in the
      // pre-Scribe update, which already ran before the throw.
    }

    assert.ok(updates.length >= 1, 'startPipeline must call store.update at least once');
    const first = updates[0];
    assert.equal(first.model, 'claude-haiku-4-5-20251001', 'should default to system model when caller omits model');
    assert.ok(first.modelLockedAt instanceof Date, 'modelLockedAt must be stamped at creation');
  });

  it('startPipeline locks the explicit model when caller passes one', async () => {
    const { store, updates } = makeMockStore({});
    const orch = makeOrchestrator(store);

    try {
      await orch.startPipeline(
        userId,
        { idea: 'todo app', context: '', targetStack: 'react' } as never,
        'claude-opus-4-7',
      );
    } catch {
      // ignore Scribe stub failure
    }

    assert.equal(updates[0].model, 'claude-opus-4-7');
    assert.ok(updates[0].modelLockedAt instanceof Date);
  });
});
