import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScribeReasoning,
  buildProtoReasoning,
  buildTraceReasoning,
  buildCriticReasoning,
} from '../reasoningFactory.js';
import { ExplainabilityService } from '../ExplainabilityService.js';
import type { ScribeOutput, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';

const FIXED_NOW = new Date('2026-05-07T10:00:00Z');

// ─── Fixtures ────────────────────────────────────────────────

function makeScribeOutput(overrides: Partial<ScribeOutput> = {}): ScribeOutput {
  return {
    spec: {
      title: 'Hesap Makinesi',
      problemStatement: 'Basit bir aritmetik aracı',
      userStories: [
        { id: 'us-1', as: 'kullanici', want: 'sayilar toplayabilmek', so: 'hizli hesap' },
        { id: 'us-2', as: 'kullanici', want: 'sayilar carpabilmek', so: 'hizli hesap' },
      ],
      acceptanceCriteria: [
        {
          id: 'ac-1',
          given: 'iki sayi girildi',
          when: '+ tusuna basildi',
          then: 'sonuc gosterilir',
        },
        {
          id: 'ac-2',
          given: 'iki sayi girildi',
          when: '* tusuna basildi',
          then: 'sonuc gosterilir',
        },
        { id: 'ac-3', given: 'sifira bolme', when: '/ tusu', then: 'hata gosterilir' },
      ],
      technicalConstraints: [],
      outOfScope: [],
    } as unknown as ScribeOutput['spec'],
    plan: {} as unknown as ScribeOutput['plan'],
    rawMarkdown: '# Hesap Makinesi',
    confidence: 0.92,
    clarificationsAsked: 2,
    assumptions: ['React kullanilacak', 'Local-only uygulama'],
    ...overrides,
  };
}

function makeProtoOutput(overrides: Partial<ProtoOutput> = {}): ProtoOutput {
  return {
    ok: true,
    branch: 'akis/feat-1',
    repo: 'me/calc',
    repoUrl: 'https://github.com/me/calc',
    files: [
      { filePath: 'index.html', content: '<html/>', linesOfCode: 5 },
      { filePath: 'src/App.tsx', content: 'export default App', linesOfCode: 30 },
    ],
    setupCommands: ['pnpm install'],
    summary: 'React iskeleti uretildi',
    metadata: {
      filesCreated: 8,
      totalLinesOfCode: 240,
      stackUsed: 'React + Vite',
      committed: true,
    },
    ...overrides,
  };
}

function makeTraceOutput(overrides: Partial<TraceOutput> = {}): TraceOutput {
  return {
    ok: true,
    testFiles: [{ filePath: 'tests/e2e/calc.spec.ts', content: 'test()', testCount: 6 }],
    coverageMatrix: { 'ac-1': ['t1'], 'ac-2': ['t2'] },
    testSummary: {
      totalTests: 6,
      coveragePercentage: 80,
      coveredCriteria: ['ac-1', 'ac-2'],
      uncoveredCriteria: ['ac-3'],
    },
    branch: 'akis/feat-1',
    ...overrides,
  };
}

function makeCriticResult(overrides: Partial<CriticReviewOutput> = {}): CriticReviewOutput {
  return {
    approved: true,
    overallScore: 88,
    findings: [
      {
        severity: 'minor',
        category: 'completeness',
        description: 'Kapsam disi alani daha net yazilabilir',
        suggestion: 'Out-of-scope listesine ornekler ekleyin',
      },
    ],
    summary: 'Genel olarak uygun',
    reviewType: 'spec_review',
    iteration: 1,
    hasCriticalFinding: false,
    maxSeverity: 'minor',
    ...overrides,
  };
}

// ─── Scribe ──────────────────────────────────────────────────

describe('buildScribeReasoning', () => {
  it('produces correct shape for first-time spec generation', () => {
    const r = buildScribeReasoning(makeScribeOutput(), { regenerated: false, now: FIXED_NOW });
    assert.equal(r.agentName, 'scribe');
    assert.equal(r.timestamp, FIXED_NOW);
    assert.match(r.decision, /Spec üretildi/);
    assert.match(r.decision, /Hesap Makinesi/);
    assert.equal(r.confidence.score, 92);
    assert.deepEqual(r.assumptions, ['React kullanilacak', 'Local-only uygulama']);
    assert.equal(r.risks, undefined, 'first-time should have no risks');
    // factors must enumerate counts
    assert.ok(r.confidence.factors.some((f) => f.includes('Kabul kriteri sayisi: 3')));
    assert.ok(r.confidence.factors.some((f) => f.includes('Kullanıcı hikâyesi sayısı: 2')));
  });

  it('marks regenerated specs with risk note', () => {
    const r = buildScribeReasoning(makeScribeOutput(), { regenerated: true, now: FIXED_NOW });
    assert.match(r.decision, /yeniden uretildi/);
    assert.deepEqual(r.risks, ['Spec kullanici geri bildirimiyle yeniden uretildi']);
  });

  it('rounds confidence to nearest integer percent', () => {
    const r1 = buildScribeReasoning(makeScribeOutput({ confidence: 0.674 }), {
      regenerated: false,
    });
    assert.equal(r1.confidence.score, 67);
    const r2 = buildScribeReasoning(makeScribeOutput({ confidence: 0.675 }), {
      regenerated: false,
    });
    assert.equal(r2.confidence.score, 68);
  });

  it('handles missing optional fields', () => {
    const r = buildScribeReasoning(
      makeScribeOutput({ assumptions: undefined, clarificationsAsked: 0 }),
      { regenerated: false }
    );
    assert.deepEqual(r.assumptions, []);
    assert.ok(r.reasoning.some((s) => s.includes('0 açıklayıcı')));
  });
});

// ─── Proto ───────────────────────────────────────────────────

describe('buildProtoReasoning', () => {
  // PR-D: confidence formula moved from heuristic (committed && files≥6 → 88,
  // committed → 70, else → 55) to AC coverage ratio when scribeOutput is
  // provided. Without scribeOutput we keep a neutral status-based fallback
  // (committed → 70, else → 50) so legacy call sites don't break.
  it('uses AC coverage ratio for confidence when scribeOutput is provided', () => {
    // 3 AC, 2 of them will static-match the proto files. We use a hand-rolled
    // AC list (rather than makeScribeOutput defaults) so keyword matching is
    // explicit + readable.
    const scribe = makeScribeOutput({
      spec: {
        ...makeScribeOutput().spec,
        acceptanceCriteria: [
          { id: 'ac-1', given: 'g', when: 'toplama butonu', then: 'toplam değer gösterilir' },
          { id: 'ac-2', given: 'g', when: 'çarpma butonu', then: 'çarpım değer gösterilir' },
          { id: 'ac-3', given: 'g', when: 'paylaş butonu', then: 'sosyal medya bağlantısı' },
        ],
      } as unknown as ScribeOutput['spec'],
    });
    const r = buildProtoReasoning(
      makeProtoOutput({
        files: [
          {
            filePath: 'src/calc.ts',
            content: 'function toplama() { /* sum */ }',
            linesOfCode: 5,
          },
          {
            filePath: 'src/multiply.ts',
            content: 'export function çarpma(a, b) { return a * b }',
            linesOfCode: 5,
          },
        ],
        metadata: {
          filesCreated: 8,
          totalLinesOfCode: 240,
          stackUsed: 'React + Vite',
          committed: true,
        },
      }),
      { scribeOutput: scribe }
    );
    // 2/3 AC covered → 67 (ac-3 mentions "paylaş/sosyal/medya" — no Proto match)
    assert.equal(
      r.confidence.score,
      67,
      `expected 67, got ${r.confidence.score} (factors=${JSON.stringify(r.confidence.factors)})`
    );
    assert.ok(
      r.confidence.factors.some((f) => f.includes('Kabul kriteri kapsamı: 2/3')),
      `expected AC coverage factor, got ${JSON.stringify(r.confidence.factors)}`
    );
    assert.ok(
      r.reasoning.some((line) => line.includes('2/3 kabul kriteri için kod üretildi')),
      `expected coverage reasoning line, got ${JSON.stringify(r.reasoning)}`
    );
  });

  it('fallback confidence when scribeOutput is missing — committed → 70', () => {
    const r = buildProtoReasoning(
      makeProtoOutput({
        metadata: { filesCreated: 3, totalLinesOfCode: 50, stackUsed: 'React', committed: true },
      })
    );
    assert.equal(r.confidence.score, 70);
    // No AC coverage factor since the spec wasn't passed in
    assert.ok(!r.confidence.factors.some((f) => f.includes('Kabul kriteri kapsamı')));
  });

  it('fallback confidence when scribeOutput is missing — uncommitted → 50', () => {
    const r = buildProtoReasoning(
      makeProtoOutput({
        metadata: {
          filesCreated: 8,
          totalLinesOfCode: 240,
          stackUsed: 'React + Vite',
          committed: false,
        },
      })
    );
    assert.equal(r.confidence.score, 50);
    assert.equal(r.risks, undefined);
    assert.ok(
      r.confidence.factors.some((f) => f.includes('Sadece local taslak')),
      `expected a 'Sadece local taslak' factor, got: ${JSON.stringify(r.confidence.factors)}`
    );
  });

  it('committed scaffold uses bakkal-Türkçesi "uzaktaki repoya gönderildi" factor', () => {
    const r = buildProtoReasoning(
      makeProtoOutput({
        metadata: {
          filesCreated: 8,
          totalLinesOfCode: 240,
          stackUsed: 'React + Vite',
          committed: true,
        },
      })
    );
    assert.ok(
      r.confidence.factors.some((f) => f === 'Uzaktaki repoya gönderildi'),
      `expected 'Uzaktaki repoya gönderildi' factor, got: ${JSON.stringify(r.confidence.factors)}`
    );
    // And confirm the old jargon is gone
    assert.ok(
      !r.confidence.factors.some((f) => f.toLowerCase().includes("github'a gönderildi:")),
      'old "GitHub\'a gönderildi: ..." factor should be removed'
    );
  });

  it('zero-AC spec falls back to status-based confidence (no AC factor)', () => {
    const scribe = makeScribeOutput({
      spec: {
        ...makeScribeOutput().spec,
        acceptanceCriteria: [],
      } as unknown as ScribeOutput['spec'],
    });
    const r = buildProtoReasoning(
      makeProtoOutput({
        metadata: { filesCreated: 5, totalLinesOfCode: 100, stackUsed: 'React', committed: true },
      }),
      { scribeOutput: scribe }
    );
    assert.equal(r.confidence.score, 70);
    assert.ok(!r.confidence.factors.some((f) => f.includes('Kabul kriteri kapsamı')));
  });

  it('decision contains file count and LOC', () => {
    const r = buildProtoReasoning(makeProtoOutput());
    assert.match(r.decision, /8 dosya/);
    assert.match(r.decision, /240 satir/);
  });

  it('includes summary in reasoning when provided', () => {
    const r = buildProtoReasoning(makeProtoOutput({ summary: 'Sandbox-ready hesap makinesi' }));
    assert.ok(r.reasoning.includes('Sandbox-ready hesap makinesi'));
  });
});

// ─── Trace ───────────────────────────────────────────────────

describe('buildTraceReasoning', () => {
  it('confidence equals coverage percentage', () => {
    const r = buildTraceReasoning(
      makeTraceOutput({
        testSummary: {
          totalTests: 10,
          coveragePercentage: 75,
          coveredCriteria: [],
          uncoveredCriteria: [],
        },
      })
    );
    assert.equal(r.confidence.score, 75);
  });

  it('lists uncovered AC as risk when present', () => {
    const r = buildTraceReasoning(makeTraceOutput());
    assert.ok(r.risks);
    assert.match(r.risks![0]!, /ac-3/);
  });

  it('no risks when all AC covered', () => {
    const r = buildTraceReasoning(
      makeTraceOutput({
        testSummary: {
          totalTests: 5,
          coveragePercentage: 100,
          coveredCriteria: ['ac-1'],
          uncoveredCriteria: [],
        },
      })
    );
    assert.equal(r.risks, undefined);
  });

  it('truncates long uncovered AC list with ellipsis', () => {
    const lots = Array.from({ length: 8 }, (_, i) => `ac-${i + 1}`);
    const r = buildTraceReasoning(
      makeTraceOutput({
        testSummary: {
          totalTests: 0,
          coveragePercentage: 0,
          coveredCriteria: [],
          uncoveredCriteria: lots,
        },
      })
    );
    assert.match(r.risks![0]!, /\.\.\.$/);
  });

  it('includes Gherkin feature count when feature files present', () => {
    const r = buildTraceReasoning(
      makeTraceOutput({
        gherkinFeatures: [
          {
            featureName: 'Calc',
            filePath: 'features/calc.feature',
            content: '',
            scenarioCount: 3,
            mappedCriteria: [],
          },
        ],
      })
    );
    assert.ok(r.reasoning.some((s) => s.includes('1 Gherkin feature')));
  });
});

// ─── Critic ──────────────────────────────────────────────────

describe('buildCriticReasoning', () => {
  it('uses spec-specific decision label for spec review', () => {
    const r = buildCriticReasoning(makeCriticResult({ approved: true }), { reviewType: 'spec' });
    assert.equal(r.decision, 'Spec uygun bulundu');
  });

  it('uses code-specific decision label for code review', () => {
    const r = buildCriticReasoning(makeCriticResult({ approved: false }), { reviewType: 'code' });
    assert.equal(r.decision, 'Kod düzeltme gerekli');
  });

  it('elevates critical and major findings to risks', () => {
    const r = buildCriticReasoning(
      makeCriticResult({
        findings: [
          {
            severity: 'critical',
            category: 'security',
            description: 'XSS açığı',
            suggestion: 'Sanitize',
          },
          {
            severity: 'major',
            category: 'consistency',
            description: 'API tutarsiz',
            suggestion: 'Standardize',
          },
          {
            severity: 'minor',
            category: 'completeness',
            description: 'Yorum az',
            suggestion: 'Yorum ekle',
          },
        ],
      }),
      { reviewType: 'code' }
    );
    assert.equal(r.risks?.length, 2);
    assert.ok(r.risks?.includes('XSS açığı'));
    assert.ok(r.risks?.includes('API tutarsiz'));
    assert.ok(!r.risks?.includes('Yorum az'));
  });

  it('omits risks field when no critical/major findings', () => {
    const r = buildCriticReasoning(makeCriticResult(), { reviewType: 'spec' });
    assert.equal(r.risks, undefined);
  });
});

// ─── End-to-end via ExplainabilityService ──────────────────

describe('ExplainabilityService integration with factories', () => {
  it('aggregates a 4-stage pipeline narrative correctly', async () => {
    const svc = new ExplainabilityService({ db: null });
    const pid = 'p-001';
    await svc.addReasoning(pid, buildScribeReasoning(makeScribeOutput(), { regenerated: false }));
    await svc.addReasoning(pid, buildCriticReasoning(makeCriticResult(), { reviewType: 'spec' }));
    await svc.addReasoning(pid, buildProtoReasoning(makeProtoOutput()));
    await svc.addReasoning(pid, buildTraceReasoning(makeTraceOutput()));

    const explanation = await svc.getExplanation(pid);
    assert.equal(explanation.stages.length, 4);
    assert.equal(explanation.stages[0]!.agentName, 'scribe');
    assert.equal(explanation.stages[1]!.agentName, 'critic');
    assert.equal(explanation.stages[2]!.agentName, 'proto');
    assert.equal(explanation.stages[3]!.agentName, 'trace');

    // narrative covers all four
    const narrative = explanation.overallNarrative;
    assert.match(narrative, /Scribe/);
    assert.match(narrative, /Critic/);
    assert.match(narrative, /Proto/);
    assert.match(narrative, /Trace/);
  });

  it('flags Trace uncovered AC as low-severity attention point', async () => {
    const svc = new ExplainabilityService({ db: null });
    await svc.addReasoning('p', buildTraceReasoning(makeTraceOutput()));
    const points = await svc.getAttentionPoints('p');
    // Trace risk → low severity per ExplainabilityService rules
    assert.ok(points.some((p) => p.severity === 'low' && p.issue.includes('riskler')));
  });

  it('flags rejected critic-code as high-severity attention via medium-confidence path', async () => {
    const svc = new ExplainabilityService({ db: null });
    await svc.addReasoning(
      'p',
      buildCriticReasoning(
        makeCriticResult({
          approved: false,
          overallScore: 60,
          findings: [
            {
              severity: 'critical',
              category: 'security',
              description: 'Auth bypass',
              suggestion: 'Fix middleware',
            },
          ],
        }),
        { reviewType: 'code' }
      )
    );
    const points = await svc.getAttentionPoints('p');
    // overallScore 60 → low confidence → high severity
    assert.ok(points.some((p) => p.severity === 'high'));
  });

  it('keeps critic-spec and critic-code as separate stage rows', async () => {
    const svc = new ExplainabilityService({ db: null });
    await svc.addReasoning('p2', buildCriticReasoning(makeCriticResult(), { reviewType: 'spec' }));
    await svc.addReasoning('p2', buildCriticReasoning(makeCriticResult(), { reviewType: 'code' }));
    const explanation = await svc.getExplanation('p2');
    assert.equal(explanation.stages.length, 2, 'critic-spec and critic-code must not collapse');
    const keys = explanation.stages.map((s) => s.stageKey ?? s.agentName);
    assert.deepEqual(keys.sort(), ['critic-code', 'critic-spec']);
  });
});
