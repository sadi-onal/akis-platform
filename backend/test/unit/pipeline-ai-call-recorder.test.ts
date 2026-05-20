// T1: unit tests for PipelineAiCallRecorder — covers ALS-gated write,
// per-pipeline callIndex monotonicity, fail-safe behavior, and the legacy
// no-op path (no pipeline context active).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PipelineAiCallRecorder } from '../../src/pipeline/core/ai-calls/PipelineAiCallRecorder.js';
import { pipelineCallContext } from '../../src/pipeline/core/ai-calls/pipelineCallContext.js';
import type { AICallMetrics } from '../../src/services/ai/AIService.js';

interface CapturedInsert {
  table: unknown;
  values: unknown;
}

function buildFakeDb(): {
  db: { insert: (table: unknown) => unknown };
  captured: CapturedInsert[];
} {
  const captured: CapturedInsert[] = [];
  const db = {
    insert(table: unknown) {
      return {
        values(values: unknown) {
          captured.push({ table, values });
          return {
            catch() {
              return Promise.resolve();
            },
            then(onFulfilled?: () => void) {
              onFulfilled?.();
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db, captured };
}

function buildFailingDb(): { db: { insert: (table: unknown) => unknown } } {
  const db = {
    insert(_table: unknown) {
      return {
        values(_values: unknown) {
          return Promise.reject(new Error('boom'));
        },
      };
    },
  };
  return { db };
}

const baseMetrics: AICallMetrics = {
  purpose: 'plan',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  durationMs: 1234,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  estimatedCostUsd: 0.0012,
  success: true,
};

describe('PipelineAiCallRecorder', () => {
  it('no-ops when no pipeline context is active (legacy single-agent path)', () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    recorder.onAiCall(baseMetrics);

    assert.equal(captured.length, 0);
  });

  it('writes a row with pipeline_id and null job_id inside a pipeline context', async () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    await pipelineCallContext.run({ pipelineId: 'pip-1' }, async () => {
      recorder.onAiCall(baseMetrics);
    });

    assert.equal(captured.length, 1);
    const row = captured[0]!.values as Record<string, unknown>;
    assert.equal(row.pipelineId, 'pip-1');
    assert.equal(row.jobId, null);
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.model, 'claude-haiku-4-5');
    assert.equal(row.purpose, 'plan');
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 50);
    assert.equal(row.totalTokens, 150);
    assert.equal(row.durationMs, 1234);
    assert.equal(row.estimatedCostUsd, '0.0012');
    assert.equal(row.success, true);
    assert.equal(row.callIndex, 0);
  });

  it('increments callIndex per pipeline independently', async () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    await pipelineCallContext.run({ pipelineId: 'pip-a' }, async () => {
      recorder.onAiCall(baseMetrics);
      recorder.onAiCall({ ...baseMetrics, purpose: 'execute' });
      recorder.onAiCall({ ...baseMetrics, purpose: 'reflect' });
    });
    await pipelineCallContext.run({ pipelineId: 'pip-b' }, async () => {
      recorder.onAiCall(baseMetrics);
      recorder.onAiCall(baseMetrics);
    });

    const indices = captured.map((c) => (c.values as { callIndex: number }).callIndex);
    const pipelineIds = captured.map((c) => (c.values as { pipelineId: string }).pipelineId);

    assert.deepEqual(indices, [0, 1, 2, 0, 1]);
    assert.deepEqual(pipelineIds, ['pip-a', 'pip-a', 'pip-a', 'pip-b', 'pip-b']);
  });

  it('records error metadata when the AI call failed', async () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    await pipelineCallContext.run({ pipelineId: 'pip-err' }, async () => {
      recorder.onAiCall({
        ...baseMetrics,
        success: false,
        errorCode: 'TIMEOUT',
      });
    });

    const row = captured[0]!.values as Record<string, unknown>;
    assert.equal(row.success, false);
    assert.equal(row.errorCode, 'TIMEOUT');
  });

  it('persists prompt/response content and structured thinking/toolCalls', async () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    const thinking = [{ type: 'thinking', text: 'hmm' }];
    const tools = [{ name: 'gh_read', input: {} }];

    await pipelineCallContext.run({ pipelineId: 'pip-content' }, async () => {
      recorder.onAiCall({
        ...baseMetrics,
        content: {
          systemPrompt: 'You are AKIS',
          userPrompt: 'Build a TODO',
          responseText: '{"plan":"x"}',
          thinkingBlocks: thinking,
          toolCalls: tools,
        },
      });
    });

    const row = captured[0]!.values as Record<string, unknown>;
    assert.equal(row.systemPrompt, 'You are AKIS');
    assert.equal(row.userPrompt, 'Build a TODO');
    assert.equal(row.responseText, '{"plan":"x"}');
    assert.deepEqual(row.thinkingBlocks, thinking);
    assert.deepEqual(row.toolCalls, tools);
  });

  it('does not throw when the DB insert rejects', async () => {
    const { db } = buildFailingDb();
    const recorder = new PipelineAiCallRecorder({ db });

    await pipelineCallContext.run({ pipelineId: 'pip-fail' }, async () => {
      assert.doesNotThrow(() => recorder.onAiCall(baseMetrics));
    });
    // Give the rejected promise a tick to settle so the logger.warn fires.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('forgetPipeline resets the per-pipeline callIndex counter', async () => {
    const { db, captured } = buildFakeDb();
    const recorder = new PipelineAiCallRecorder({ db });

    await pipelineCallContext.run({ pipelineId: 'pip-reset' }, async () => {
      recorder.onAiCall(baseMetrics);
      recorder.onAiCall(baseMetrics);
    });
    recorder.forgetPipeline('pip-reset');
    await pipelineCallContext.run({ pipelineId: 'pip-reset' }, async () => {
      recorder.onAiCall(baseMetrics);
    });

    const indices = captured.map((c) => (c.values as { callIndex: number }).callIndex);
    assert.deepEqual(indices, [0, 1, 0]);
  });

  it('honours db: null by becoming a complete no-op', () => {
    const recorder = new PipelineAiCallRecorder({ db: null });
    assert.doesNotThrow(() =>
      pipelineCallContext.run({ pipelineId: 'pip-null' }, () => {
        recorder.onAiCall(baseMetrics);
        return Promise.resolve();
      })
    );
  });
});
