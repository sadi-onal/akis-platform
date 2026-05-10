import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExplainabilityService } from '../../src/pipeline/core/explainability/ExplainabilityService.js';
import type { AgentReasoning } from '../../src/pipeline/core/explainability/ExplainabilityTypes.js';

function makeReasoning(overrides: Partial<AgentReasoning> = {}): AgentReasoning {
  return {
    agentName: 'scribe',
    timestamp: new Date('2026-04-15T10:00:00Z'),
    decision: 'Spec uretildi',
    reasoning: ['Kullanici fikri analiz edildi'],
    assumptions: ['React kullanilacak'],
    confidence: { score: 90, factors: ['Net gereksinimler'] },
    ...overrides,
  };
}

/**
 * Cache-only mode (`db: null`) keeps these tests pure-unit — no DB required.
 * Persistence behaviour is exercised by the integration suite
 * (`test/integration/explainability-persistence.test.ts`).
 */
function svc(opts: ConstructorParameters<typeof ExplainabilityService>[0] = {}) {
  return new ExplainabilityService({ db: null, ...opts });
}

describe('ExplainabilityService', () => {
  it('stores and retrieves a single reasoning entry', async () => {
    const s = svc();
    await s.addReasoning('p1', makeReasoning());
    const explanation = await s.getExplanation('p1');
    assert.equal(explanation.pipelineId, 'p1');
    assert.equal(explanation.stages.length, 1);
    assert.equal(explanation.stages[0]!.agentName, 'scribe');
  });

  it('returns all stages for a pipeline with multiple reasoning entries', async () => {
    const s = svc();
    await s.addReasoning('p2', makeReasoning({ agentName: 'scribe' }));
    await s.addReasoning('p2', makeReasoning({ agentName: 'proto', decision: 'MVP uretildi' }));
    await s.addReasoning('p2', makeReasoning({ agentName: 'trace', decision: 'Testler yazildi' }));
    const explanation = await s.getExplanation('p2');
    assert.equal(explanation.stages.length, 3);
    assert.ok(explanation.overallNarrative.length > 0);
  });

  it('generates a Turkish narrative from template for scribe stage', async () => {
    const s = svc();
    await s.addReasoning(
      'p3',
      makeReasoning({
        agentName: 'scribe',
        confidence: { score: 85, factors: ['Acik fikir'] },
        assumptions: ['SPA olacak', 'Tailwind kullanilacak'],
      }),
    );
    const narrative = await s.generateNarrative('p3');
    assert.ok(narrative.includes('85%'));
    assert.ok(narrative.includes('2 varsayim'));
    assert.ok(narrative.includes('Scribe'));
  });

  it('flags high severity attention point for confidence below 70', async () => {
    const s = svc();
    await s.addReasoning(
      'p4',
      makeReasoning({ confidence: { score: 55, factors: ['Belirsiz gereksinimler'] } }),
    );
    const points = await s.getAttentionPoints('p4');
    assert.ok(points.length >= 1);
    const high = points.find((p) => p.severity === 'high');
    assert.ok(high);
    assert.ok(high.issue.includes('55'));
  });

  it('flags attention point when critic reasoning mentions security', async () => {
    const s = svc();
    await s.addReasoning(
      'p5',
      makeReasoning({
        agentName: 'critic',
        decision: 'Guvenlik acigi tespit edildi',
        reasoning: ['SQL injection security riski bulundu'],
        confidence: { score: 92, factors: ['Kod incelendi'] },
      }),
    );
    const points = await s.getAttentionPoints('p5');
    const securityPoint = points.find((p) => p.issue.includes('Guvenlik'));
    assert.ok(securityPoint);
    assert.equal(securityPoint.severity, 'high');
  });

  it('returns empty stages for unknown pipeline (cache-only mode keeps preEpoch flag clear)', async () => {
    const s = svc();
    const explanation = await s.getExplanation('nonexistent');
    assert.equal(explanation.pipelineId, 'nonexistent');
    assert.equal(explanation.stages.length, 0);
    assert.equal(explanation.attentionPoints.length, 0);
    assert.ok(explanation.overallNarrative.includes('henuz'));
    // Review-fix #1: cache-only mode (db === null) cannot determine pipeline
    // status, so persistencePreEpoch stays unset. Integration suite covers
    // the actual terminal-pipeline gating with a real DB.
    assert.equal(explanation.meta?.persistencePreEpoch, undefined);
  });

  it('keeps pipelines isolated from each other', async () => {
    const s = svc();
    await s.addReasoning('alpha', makeReasoning({ agentName: 'scribe' }));
    await s.addReasoning('beta', makeReasoning({ agentName: 'proto' }));
    await s.addReasoning('beta', makeReasoning({ agentName: 'trace' }));
    const alpha = await s.getExplanation('alpha');
    const beta = await s.getExplanation('beta');
    assert.equal(alpha.stages.length, 1);
    assert.equal(beta.stages.length, 2);
  });

  it('narrative text reflects exact assumption count and confidence', async () => {
    const s = svc();
    await s.addReasoning(
      'p8',
      makeReasoning({
        agentName: 'scribe',
        confidence: { score: 78, factors: ['Orta netlik'] },
        assumptions: ['A1', 'A2', 'A3'],
      }),
    );
    const narrative = await s.generateNarrative('p8');
    assert.ok(narrative.includes('78%'));
    assert.ok(narrative.includes('3 varsayim'));
  });

  it('flags attention when trace fix loop triggered', async () => {
    const s = svc();
    await s.addReasoning(
      'p9',
      makeReasoning({
        agentName: 'trace',
        decision: 'fix loop triggered for failing tests',
        confidence: { score: 88, factors: ['Test basarisiz'] },
      }),
    );
    const points = await s.getAttentionPoints('p9');
    const fixPoint = points.find((p) => p.issue.includes('Duzeltme dongusu'));
    assert.ok(fixPoint);
    assert.equal(fixPoint.severity, 'medium');
  });

  it('flags medium severity for confidence between 70 and 84', async () => {
    const s = svc();
    await s.addReasoning(
      'p10',
      makeReasoning({ confidence: { score: 75, factors: ['Kismi bilgi'] } }),
    );
    const points = await s.getAttentionPoints('p10');
    const medium = points.find((p) => p.severity === 'medium');
    assert.ok(medium);
    assert.ok(medium.issue.includes('75'));
  });

  it('surfaces risk attention points when includeRisks is true', async () => {
    const s = svc({ includeRisks: true });
    await s.addReasoning(
      'p11',
      makeReasoning({
        confidence: { score: 95, factors: ['Cok net'] },
        risks: ['Performans riski'],
      }),
    );
    const points = await s.getAttentionPoints('p11');
    const riskPoint = points.find((p) => p.issue.includes('risk'));
    assert.ok(riskPoint);
    assert.equal(riskPoint.severity, 'low');
  });

  it('hides risk points when includeRisks is false', async () => {
    const s = svc({ includeRisks: false });
    await s.addReasoning(
      'p12',
      makeReasoning({
        confidence: { score: 95, factors: ['Net'] },
        risks: ['Performans riski'],
      }),
    );
    const points = await s.getAttentionPoints('p12');
    const riskPoint = points.find((p) => p.issue.includes('risk'));
    assert.equal(riskPoint, undefined);
  });

  // ─── Cache-hit & write-through unit assertions ─────────────────────────

  it('cache hit: getExplanation does not query DB after addReasoning', async () => {
    let dbReadCount = 0;
    const fakeDb = makeFakeDb({
      onSelect: () => {
        dbReadCount += 1;
      },
    });
    const s = new ExplainabilityService({ db: fakeDb });
    await s.addReasoning('cache-hit', makeReasoning());
    await s.getExplanation('cache-hit');
    await s.getExplanation('cache-hit');
    assert.equal(dbReadCount, 0, 'no DB read should happen when the cache is warm');
  });

  it('write-through: addReasoning issues an UPSERT', async () => {
    let inserts = 0;
    const fakeDb = makeFakeDb({
      onInsert: () => {
        inserts += 1;
      },
    });
    const s = new ExplainabilityService({ db: fakeDb });
    await s.addReasoning('wt', makeReasoning({ agentName: 'scribe' }));
    await s.addReasoning('wt', makeReasoning({ agentName: 'proto' }));
    assert.equal(inserts, 2, 'each addReasoning should write through to the DB');
  });

  // ─── persistencePreEpoch terminal-gate (review-fix #1) ─────────────────

  it('persistencePreEpoch is NOT set for an active pipeline with no stages', async () => {
    // Active stage like `scribe_clarifying` — the pipeline JUST started and
    // hasn't emitted reasoning yet. Banner must NOT fire.
    const fakeDb = makeFakeDb({
      pipelineRows: [{ stage: 'scribe_clarifying' }],
      reasoningRows: [],
    });
    const s = new ExplainabilityService({ db: fakeDb });
    const explanation = await s.getExplanation('active');
    assert.equal(explanation.stages.length, 0);
    assert.equal(
      explanation.meta?.persistencePreEpoch,
      undefined,
      'active pipelines must not get the legacy banner',
    );
  });

  it('persistencePreEpoch IS set for a completed pipeline with no stages', async () => {
    const fakeDb = makeFakeDb({
      pipelineRows: [{ stage: 'completed' }],
      reasoningRows: [],
    });
    const s = new ExplainabilityService({ db: fakeDb });
    const explanation = await s.getExplanation('legacy');
    assert.equal(explanation.stages.length, 0);
    assert.equal(
      explanation.meta?.persistencePreEpoch,
      true,
      'completed pipeline with zero stages → legacy banner',
    );
  });

  it('persistencePreEpoch IS set for failed/cancelled/completed_partial terminal stages', async () => {
    for (const stage of ['failed', 'cancelled', 'completed_partial']) {
      const fakeDb = makeFakeDb({
        pipelineRows: [{ stage }],
        reasoningRows: [],
      });
      const s = new ExplainabilityService({ db: fakeDb });
      const explanation = await s.getExplanation(`p-${stage}`);
      assert.equal(
        explanation.meta?.persistencePreEpoch,
        true,
        `stage ${stage} should be considered terminal`,
      );
    }
  });

  it('persistencePreEpoch is NOT set for proto_building / awaiting_approval', async () => {
    for (const stage of ['proto_building', 'awaiting_approval', 'trace_testing']) {
      const fakeDb = makeFakeDb({
        pipelineRows: [{ stage }],
        reasoningRows: [],
      });
      const s = new ExplainabilityService({ db: fakeDb });
      const explanation = await s.getExplanation(`p-${stage}`);
      assert.equal(
        explanation.meta?.persistencePreEpoch,
        undefined,
        `stage ${stage} is non-terminal, banner must NOT fire`,
      );
    }
  });
});

/**
 * Minimal Drizzle-shape stub. Mirrors:
 *   - `.insert(...).values(...).onConflictDoUpdate(...)`
 *   - `.select(...).from(...).where(...).orderBy(...)` for reasoning load
 *   - `.select(...).from(...).where(...).limit(...)` for the pipelines lookup
 *     used by `isTerminalPipeline` (review-fix #1)
 * Returns thenables so the service can `await` without a real connection.
 *
 * `pipelineRows` lets a test control what the pipelines lookup returns —
 * use `[{ stage: 'completed' }]` for a terminal pipeline, `[]` for unknown,
 * or `[{ stage: 'scribe_clarifying' }]` for an active one.
 */
function makeFakeDb(opts: {
  onSelect?: () => void;
  onInsert?: () => void;
  pipelineRows?: Array<{ stage: string }>;
  reasoningRows?: unknown[];
}) {
  const pipelineRows = opts.pipelineRows ?? [];
  const reasoningRows = opts.reasoningRows ?? [];
  return {
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              opts.onInsert?.();
              return Promise.resolve();
            },
            // Some chains may resolve directly without onConflict
            then(resolve: (v: unknown) => void) {
              opts.onInsert?.();
              return resolve(undefined);
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          // Distinguish the two real tables by a column unique to each:
          //   - pipelines has `userId`
          //   - pipeline_reasonings has `agentReasoning`
          const t = table as Record<string, unknown>;
          const isPipelines = 'userId' in t;
          return {
            where() {
              return {
                orderBy() {
                  opts.onSelect?.();
                  return Promise.resolve(reasoningRows);
                },
                limit() {
                  opts.onSelect?.();
                  return Promise.resolve(isPipelines ? pipelineRows : reasoningRows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof ExplainabilityService.prototype.constructor>[0]['db'];
}
