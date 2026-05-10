/**
 * Explainability persistence integration test (PDP-2 Wave 2 / NFR-1).
 *
 * Acceptance: a brand-new ExplainabilityService instance — simulating a
 * backend restart — recovers all reasoning entries previously written for
 * the same pipeline. Covers F-03 (state lost on restart) and F-11
 * (persistence layer didn't exist).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '../../src/db/client.js';
import { pipelineReasonings, pipelines, users } from '../../src/db/schema.js';
import { ExplainabilityService } from '../../src/pipeline/core/explainability/ExplainabilityService.js';
import type { AgentReasoning } from '../../src/pipeline/core/explainability/ExplainabilityTypes.js';

const SKIP = process.env.SKIP_DB_TESTS === 'true' || !process.env.DATABASE_URL;

function reasoningOf(stage: string, score = 90, overrides: Partial<AgentReasoning> = {}): AgentReasoning {
  return {
    agentName: stage.startsWith('critic') ? 'critic' : stage,
    ...(stage.startsWith('critic') ? { stageKey: stage } : {}),
    timestamp: new Date('2026-05-09T10:00:00Z'),
    decision: `${stage} kararı`,
    reasoning: [`${stage} adımı tamamlandı`],
    assumptions: ['varsayım-1'],
    confidence: { score, factors: [`${stage} başarılı`] },
    ...overrides,
  };
}

describe('ExplainabilityService persistence (F-03 + F-11 / NFR-1)', () => {
  let userId: string;
  let pipelineId: string;

  before(async () => {
    if (SKIP) return;
    userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      name: 'persist-test',
      email: `persist-test-${userId}@example.com`,
      passwordHash: 'x',
    });
    pipelineId = randomUUID();
    await db.insert(pipelines).values({
      id: pipelineId,
      userId,
      stage: 'completed',
      title: 'persistence test',
    });
  });

  after(async () => {
    if (SKIP) return;
    // Cascade from pipelines covers pipeline_reasonings rows.
    await db.delete(pipelines).where(eq(pipelines.id, pipelineId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('reasoning written by one service instance is recovered by a fresh instance', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    // Process #1: write three stages.
    const writer = new ExplainabilityService();
    await writer.addReasoning(pipelineId, reasoningOf('scribe', 92));
    await writer.addReasoning(pipelineId, reasoningOf('proto', 85));
    await writer.addReasoning(pipelineId, reasoningOf('trace', 78));

    // Sanity check the writer can still read its own data.
    const writerView = await writer.getExplanation(pipelineId);
    assert.equal(writerView.stages.length, 3);

    // Process #2: brand-new service, brand-new in-memory cache.
    // Equivalent to a backend restart from the user's perspective.
    const reader = new ExplainabilityService();
    const recovered = await reader.getExplanation(pipelineId);

    assert.equal(recovered.stages.length, 3, 'all 3 stages must be recovered after restart');
    const names = recovered.stages.map((s) => s.agentName).sort();
    assert.deepEqual(names, ['proto', 'scribe', 'trace']);
    assert.equal(recovered.meta?.persistencePreEpoch, undefined);
  });

  it('critic-spec and critic-code are stored as separate stage rows', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    // Use a different pipeline to avoid stage collisions across tests.
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'critic-keys',
      email: `critic-keys-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'critic test',
    });

    try {
      const writer = new ExplainabilityService();
      await writer.addReasoning(localPipelineId, reasoningOf('critic-spec'));
      await writer.addReasoning(localPipelineId, reasoningOf('critic-code'));

      // Direct DB inspection — ensure both rows exist.
      const rows = await db
        .select()
        .from(pipelineReasonings)
        .where(eq(pipelineReasonings.pipelineId, localPipelineId));
      const stages = rows.map((r) => r.stage).sort();
      assert.deepEqual(stages, ['critic-code', 'critic-spec']);
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  it('readding the same stage upserts (no duplicate rows)', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'upsert-test',
      email: `upsert-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'upsert test',
    });

    try {
      const writer = new ExplainabilityService();
      await writer.addReasoning(localPipelineId, reasoningOf('scribe', 50));
      await writer.addReasoning(localPipelineId, reasoningOf('scribe', 95)); // second write same stage

      const rows = await db
        .select()
        .from(pipelineReasonings)
        .where(eq(pipelineReasonings.pipelineId, localPipelineId));
      assert.equal(rows.length, 1, 'same stage must upsert into a single row');
      assert.equal(rows[0]!.agentReasoning.confidence.score, 95);
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  it('completed pipeline with no reasoning gets persistencePreEpoch flag', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'legacy-test',
      email: `legacy-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'legacy completed pipeline',
    });

    try {
      const reader = new ExplainabilityService();
      const explanation = await reader.getExplanation(localPipelineId);
      assert.equal(explanation.stages.length, 0);
      assert.equal(explanation.meta?.persistencePreEpoch, true);
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  // Review-fix #1: brand-new (non-terminal) pipeline with zero reasoning rows
  // must NOT trip the legacy banner — it just hasn't emitted anything yet.
  it('active pipeline with no reasoning does NOT get persistencePreEpoch flag (review #1)', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'active-test',
      email: `active-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'scribe_clarifying', // not terminal
      title: 'active pipeline',
    });

    try {
      const reader = new ExplainabilityService();
      const explanation = await reader.getExplanation(localPipelineId);
      assert.equal(explanation.stages.length, 0);
      assert.equal(
        explanation.meta?.persistencePreEpoch,
        undefined,
        'active pipelines must not get the legacy banner',
      );
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  // Review-fix #3: stage order is stable across regeneration. Re-adding
  // Scribe after Proto already wrote its row must NOT bump Scribe to the
  // end of the chronological order on a fresh-process read.
  it('stage order is stable when scribe is regenerated after proto (review #3)', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'reorder-test',
      email: `reorder-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'reorder test',
    });

    try {
      // Process #1: scribe → proto (in chronological order).
      const writer = new ExplainabilityService();
      await writer.addReasoning(localPipelineId, reasoningOf('scribe', 80));
      // Small delay to ensure scribe row's recordedAt < proto's.
      await new Promise((r) => setTimeout(r, 25));
      await writer.addReasoning(localPipelineId, reasoningOf('proto', 85));
      await new Promise((r) => setTimeout(r, 25));
      // Re-add scribe (regeneration after proto already exists). With the
      // fix in place, the upsert keeps the original `recordedAt`, so a
      // fresh read still returns scribe → proto.
      await writer.addReasoning(localPipelineId, reasoningOf('scribe', 90));

      // Fresh-process read.
      const reader = new ExplainabilityService();
      const recovered = await reader.getExplanation(localPipelineId);
      assert.equal(recovered.stages.length, 2);
      const order = recovered.stages.map((s) => s.agentName);
      assert.deepEqual(
        order,
        ['scribe', 'proto'],
        'scribe must remain before proto even after regeneration',
      );
      // Confirm the upsert *did* update the payload (confidence bumped 80→90).
      const scribe = recovered.stages.find((s) => s.agentName === 'scribe');
      assert.equal(scribe!.confidence.score, 90);
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });
});
