process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { PipelineReconciler } from '../../src/pipeline/core/PipelineReconciler.js';
import type { PipelineStore } from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type {
  PipelineState,
  PipelineStage,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

function makeStuckStore() {
  const stuck: PipelineState = {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    stage: 'trace_testing',
    title: 'Sayaç',
    scribeConversation: [
      {
        type: 'trace_started',
        content: { iteration: 1 },
        timestamp: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
    ],
    scribeOutput: null,
    approvedSpec: null,
    protoOutput: null,
    traceOutput: null,
    traceEnabled: true,
    repoContext: null,
    protoConfig: null,
    jiraConfig: null,
    metrics: {},
    error: null,
    intermediateState: null,
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(Date.now() - 30 * 60_000),
    updatedAt: new Date(Date.now() - 16 * 60_000),
    model: null,
    modelLockedAt: null,
  } as PipelineState;
  const states = new Map([[stuck.id, stuck]]);
  return {
    states,
    stuck,
    async getById(id: string) {
      return states.get(id) ?? null;
    },
    async update(id: string, patch: Partial<PipelineState>) {
      const cur = states.get(id)!;
      const next = {
        ...cur,
        ...patch,
        stageVersion: cur.stageVersion + 1,
        updatedAt: new Date(),
      } as PipelineState;
      states.set(id, next);
      return next;
    },
    async listByUser() {
      return [];
    },
    async create() {
      throw new Error('unused');
    },
    async listStuck(stages: PipelineStage[], olderThan: Date) {
      return [...states.values()]
        .filter((p) => stages.includes(p.stage) && p.updatedAt < olderThan)
        .map((p) => ({ id: p.id, stage: p.stage, updatedAt: p.updatedAt }));
    },
  };
}

describe('PipelineReconciler — chat event on timeout', () => {
  it('appends trace_failed event when a pipeline times out in trace_testing', async () => {
    const store = makeStuckStore();
    const reconciler = new PipelineReconciler(store as unknown as PipelineStore);
    const recovered = await reconciler.sweep();
    assert.equal(recovered, 1);

    const updated = store.states.get(store.stuck.id)!;
    assert.equal(updated.stage, 'failed');
    const failed = updated.scribeConversation.find((m) => m.type === 'trace_failed');
    assert.ok(
      failed,
      `expected trace_failed in ${updated.scribeConversation.map((m) => m.type).join(', ')}`
    );
    if (failed && failed.type === 'trace_failed') {
      assert.equal(failed.content.errorCode, 'PIPELINE_TIMEOUT');
      assert.equal(failed.content.recoveryAction, 'retry');
      assert.match(failed.content.errorMessage, /dakika/);
    }
  });
});
