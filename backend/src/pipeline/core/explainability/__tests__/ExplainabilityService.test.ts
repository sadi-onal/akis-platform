import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ExplainabilityService } from '../ExplainabilityService.js';
import type { ExplainabilityDb } from '../ExplainabilityService.js';
import type { AgentReasoning } from '../ExplainabilityTypes.js';

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

/** Cache-only mode: no DB calls, pure unit tests. */
function svc(opts: ConstructorParameters<typeof ExplainabilityService>[0] = {}) {
  return new ExplainabilityService({ db: null, ...opts });
}

// ─── 1. Add single reasoning, retrieve it ────────────────────

describe('ExplainabilityService', () => {
  it('stores and retrieves a single reasoning entry', async () => {
    const s = svc();
    const r = makeReasoning();
    await s.addReasoning('p1', r);

    const explanation = await s.getExplanation('p1');
    assert.equal(explanation.pipelineId, 'p1');
    assert.equal(explanation.stages.length, 1);
    assert.equal(explanation.stages[0]!.agentName, 'scribe');
  });

  // ─── 2. Add multiple stages, get full explanation ────────────

  it('returns all stages for a pipeline with multiple reasoning entries', async () => {
    const s = svc();
    await s.addReasoning('p2', makeReasoning({ agentName: 'scribe' }));
    await s.addReasoning('p2', makeReasoning({ agentName: 'proto', decision: 'MVP uretildi' }));
    await s.addReasoning('p2', makeReasoning({ agentName: 'trace', decision: 'Testler yazildi' }));

    const explanation = await s.getExplanation('p2');
    assert.equal(explanation.stages.length, 3);
    assert.equal(explanation.stages[0]!.agentName, 'scribe');
    assert.equal(explanation.stages[1]!.agentName, 'proto');
    assert.equal(explanation.stages[2]!.agentName, 'trace');
    assert.ok(explanation.overallNarrative.length > 0);
  });

  // ─── 3. Generate narrative with template ─────────────────────

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

  // ─── 4. Attention points for low confidence (< 70) ──────────

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

  // ─── 5. Attention points for security-related critic ─────────

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

  // ─── 6. Empty pipeline returns empty explanation ─────────────

  it('returns empty stages and default narrative for unknown pipeline', async () => {
    const s = svc();

    const explanation = await s.getExplanation('nonexistent');
    assert.equal(explanation.pipelineId, 'nonexistent');
    assert.equal(explanation.stages.length, 0);
    assert.equal(explanation.attentionPoints.length, 0);
    assert.ok(explanation.overallNarrative.includes('henuz'));
    // Cache-only mode (db: null) cannot determine pipeline status, so the
    // persistencePreEpoch flag stays unset. This is intentional —
    // see review-fix #1: only terminal pipelines with zero rows trip it.
    assert.equal(explanation.meta?.persistencePreEpoch, undefined);
  });

  // ─── 6b. persistencePreEpoch is gated on pipeline status (review #1) ──

  /**
   * Build a minimal Drizzle-shape stub that returns canned responses for
   * `select(...).from(...).where(...)`. Inspects the `name` symbol on the
   * table to decide which rows to return:
   *   - reasonings table → reasoningRows
   *   - pipelines table → pipelineRows
   * Any insert is a no-op.
   */
  function dbStub({
    pipelineRows,
    reasoningRows,
  }: {
    pipelineRows: Array<{ stage: string }>;
    reasoningRows: Array<unknown>;
  }) {
    return {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => undefined,
        }),
      }),
      select: () => ({
        from: (table: unknown) => {
          // Distinguish the two real tables by a column unique to each:
          //   - pipelines has `userId`
          //   - pipeline_reasonings has `agentReasoning`
          // Either is enough as a brand check.
          const t = table as Record<string, unknown>;
          const isPipelines = 'userId' in t;
          const make = (rows: unknown[]) => ({
            where: () => ({
              limit: async () => rows,
              orderBy: async () => rows,
            }),
          });
          return isPipelines ? make(pipelineRows) : make(reasoningRows);
        },
      }),
    } as unknown as ExplainabilityDb;
  }

  it('does NOT set persistencePreEpoch for an active pipeline with no stages yet', async () => {
    const fakeDb = dbStub({
      pipelineRows: [{ stage: 'scribe_clarifying' }],
      reasoningRows: [],
    });
    const s = new ExplainabilityService({ db: fakeDb });
    const explanation = await s.getExplanation('active-pipeline');
    assert.equal(explanation.stages.length, 0);
    assert.equal(
      explanation.meta?.persistencePreEpoch,
      undefined,
      'active pipelines must NOT trip the legacy banner',
    );
  });

  it('SETS persistencePreEpoch for a completed pipeline with no stages', async () => {
    const fakeDb = dbStub({
      pipelineRows: [{ stage: 'completed' }],
      reasoningRows: [],
    });
    const s = new ExplainabilityService({ db: fakeDb });
    const explanation = await s.getExplanation('legacy-pipeline');
    assert.equal(explanation.stages.length, 0);
    assert.equal(
      explanation.meta?.persistencePreEpoch,
      true,
      'completed pipeline with zero stages → legacy banner',
    );
  });

  // ─── 7. Multiple pipelines stored independently ──────────────

  it('keeps pipelines isolated from each other', async () => {
    const s = svc();
    await s.addReasoning('alpha', makeReasoning({ agentName: 'scribe' }));
    await s.addReasoning('beta', makeReasoning({ agentName: 'proto' }));
    await s.addReasoning('beta', makeReasoning({ agentName: 'trace' }));

    const alpha = await s.getExplanation('alpha');
    const beta = await s.getExplanation('beta');

    assert.equal(alpha.stages.length, 1);
    assert.equal(beta.stages.length, 2);
    assert.equal(alpha.stages[0]!.agentName, 'scribe');
    assert.equal(beta.stages[0]!.agentName, 'proto');
  });

  // ─── 8. Narrative includes assumption count and confidence ───

  it('narrative text reflects exact assumption count and confidence percentage', async () => {
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
    assert.ok(narrative.includes('78%'), 'Should include confidence percentage');
    assert.ok(narrative.includes('3 varsayim'), 'Should include assumption count');
  });

  // ─── 9. Trace fix loop triggers attention point ──────────────

  it('flags attention point when trace decision includes fix', async () => {
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

  // ─── 10. Medium confidence (70-84) → medium severity ─────────

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

  // ─── 11. Config controls risk surfacing ──────────────────────

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

  // ─── 12. Config with includeRisks=false hides risk points ───

  it('does not surface risk attention points when includeRisks is false', async () => {
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
});
