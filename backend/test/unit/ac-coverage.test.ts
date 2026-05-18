// PR-D: AC Coverage metric — backend unit tests run by `pnpm test:unit`.
// Mirrors a subset of the co-located __tests__ suite so the regression is
// caught by CI. See src/pipeline/core/explainability/acCoverage.ts for the
// research rationale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAcCoverage } from '../../src/pipeline/core/explainability/acCoverage.js';
import { buildProtoReasoning } from '../../src/pipeline/core/explainability/reasoningFactory.js';
import type {
  ScribeOutput,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Fixtures ────────────────────────────────────────────────

function makeScribeOutput(
  acceptanceCriteria: ScribeOutput['spec']['acceptanceCriteria'] = []
): ScribeOutput {
  return {
    spec: {
      title: 'QR Generator',
      problemStatement: 'QR kod üretme aracı',
      userStories: [],
      acceptanceCriteria,
      technicalConstraints: {},
      outOfScope: [],
    },
    plan: {} as unknown as ScribeOutput['plan'],
    rawMarkdown: '# QR',
    confidence: 0.9,
    clarificationsAsked: 0,
  };
}

function makeProtoOutput(files: ProtoOutput['files'] = []): ProtoOutput {
  return {
    ok: true,
    branch: 'akis/qr',
    repo: 'me/qr',
    repoUrl: 'https://github.com/me/qr',
    files,
    setupCommands: [],
    metadata: {
      filesCreated: files.length,
      totalLinesOfCode: files.reduce((a, f) => a + f.linesOfCode, 0),
      stackUsed: 'React',
      committed: true,
    },
  };
}

function makeTraceOutput(
  testFiles: TraceOutput['testFiles'] = [],
  coverageMatrix: Record<string, string[]> = {}
): TraceOutput {
  return {
    ok: true,
    testFiles,
    coverageMatrix,
    testSummary: {
      totalTests: testFiles.reduce((a, f) => a + f.testCount, 0),
      coveragePercentage: 0,
      coveredCriteria: [],
      uncoveredCriteria: [],
    },
  };
}

// ─── buildAcCoverage ─────────────────────────────────────────

describe('buildAcCoverage', () => {
  it('returns empty report when no AC defined', () => {
    const report = buildAcCoverage(makeScribeOutput([]), makeProtoOutput(), undefined);
    assert.equal(report.totalAcs, 0);
    assert.equal(report.staticCoveredCount, 0);
    assert.equal(report.dynamicCoveredCount, 0);
    assert.deepEqual(report.items, []);
  });

  it('returns empty report when scribeOutput is undefined', () => {
    const report = buildAcCoverage(undefined, makeProtoOutput(), undefined);
    assert.equal(report.totalAcs, 0);
  });

  it('static-covers AC whose keywords match Proto files', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'QR butonuna basıldığında', then: 'PNG indirir' },
      { id: 'ac-2', given: 'g', when: 'Geçmiş açıldığında', then: 'eski indirmeler listelenir' },
    ]);
    const proto = makeProtoOutput([
      {
        filePath: 'src/components/QrForm.tsx',
        content: 'import qrcode from "qrcode"; export function downloadPng() {}',
        linesOfCode: 20,
      },
    ]);
    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.totalAcs, 2);
    assert.equal(report.items.find((i) => i.acId === 'ac-1')!.staticCovered, true);
    assert.equal(report.items.find((i) => i.acId === 'ac-2')!.staticCovered, false);
    assert.equal(report.staticCoveredCount, 1);
  });

  it('dynamic-covers AC via coverageMatrix (authoritative source)', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'QR butonu', then: 'PNG indir' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode png', linesOfCode: 5 },
    ]);
    const trace = makeTraceOutput(
      [
        {
          filePath: 'tests/qr.spec.ts',
          content: 'test("downloads PNG", () => {})',
          testCount: 1,
        },
      ],
      { 'ac-1': ['downloads PNG'] }
    );
    const report = buildAcCoverage(scribe, proto, trace);
    assert.equal(report.items[0]!.dynamicCovered, true);
    assert.deepEqual(report.items[0]!.coveringTests, ['tests/qr.spec.ts']);
  });

  it('dynamic falls back to keyword match when coverageMatrix is empty', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butona', then: 'qrcode indirir' },
    ]);
    const proto = makeProtoOutput([{ filePath: 'src/QR.tsx', content: 'qrcode', linesOfCode: 5 }]);
    const trace = makeTraceOutput([
      { filePath: 'tests/qr.spec.ts', content: 'test("renders qrcode")', testCount: 1 },
    ]);
    const report = buildAcCoverage(scribe, proto, trace);
    assert.equal(report.items[0]!.dynamicCovered, true);
    assert.deepEqual(report.items[0]!.coveringTests, ['tests/qr.spec.ts']);
  });

  it('caps coveringFiles list at 3 entries', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butona', then: 'qrcode indirilir' },
    ]);
    const proto = makeProtoOutput(
      Array.from({ length: 6 }, (_, i) => ({
        filePath: `src/file${i}.tsx`,
        content: 'qrcode',
        linesOfCode: 1,
      }))
    );
    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.items[0]!.coveringFiles.length, 3);
  });

  it('partial coverage scenario reports correct counts', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butona', then: 'qrcode üretir' },
      { id: 'ac-2', given: 'g', when: 'kaydet', then: 'png indirir' },
      { id: 'ac-3', given: 'g', when: 'paylaş', then: 'sosyal medya bağlantısı çıkar' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode generation', linesOfCode: 30 },
      { filePath: 'src/Download.tsx', content: 'png download', linesOfCode: 15 },
    ]);
    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.totalAcs, 3);
    assert.equal(report.staticCoveredCount, 2);
    assert.equal(report.dynamicCoveredCount, 0);
  });
});

// ─── buildProtoReasoning AC integration ──────────────────────

describe('buildProtoReasoning AC coverage integration (PR-D)', () => {
  it('uses AC coverage ratio when scribeOutput is provided', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'toplama butonu', then: 'toplam değer' },
      { id: 'ac-2', given: 'g', when: 'çarpma butonu', then: 'çarpım değer' },
      { id: 'ac-3', given: 'g', when: 'paylaş butonu', then: 'sosyal medya bağlantısı' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/sum.ts', content: 'toplama logic', linesOfCode: 5 },
      { filePath: 'src/mul.ts', content: 'çarpma logic', linesOfCode: 5 },
    ]);
    const r = buildProtoReasoning(proto, { scribeOutput: scribe });
    // 2/3 covered → 67
    assert.equal(r.confidence.score, 67);
    assert.ok(
      r.confidence.factors.some((f) => f.includes('Kabul kriteri kapsamı: 2/3')),
      `expected coverage factor, got ${JSON.stringify(r.confidence.factors)}`
    );
  });

  it('falls back to status-based confidence when scribeOutput is missing', () => {
    const proto = makeProtoOutput([
      { filePath: 'src/app.ts', content: 'code', linesOfCode: 5 },
    ]);
    const rCommitted = buildProtoReasoning(proto);
    assert.equal(rCommitted.confidence.score, 70);
    const rUncommitted = buildProtoReasoning({
      ...proto,
      metadata: { ...proto.metadata, committed: false },
    });
    assert.equal(rUncommitted.confidence.score, 50);
  });

  it('falls back to status-based confidence when spec has zero AC', () => {
    const scribe = makeScribeOutput([]);
    const proto = makeProtoOutput([{ filePath: 'src/app.ts', content: 'code', linesOfCode: 5 }]);
    const r = buildProtoReasoning(proto, { scribeOutput: scribe });
    // No AC → fall back; committed → 70
    assert.equal(r.confidence.score, 70);
    assert.ok(!r.confidence.factors.some((f) => f.includes('Kabul kriteri kapsamı')));
  });

  it('does NOT use the old (committed && files≥6 → 88) heuristic', () => {
    // 8 files, committed, but NO scribeOutput passed → should be 70, not 88
    const proto: ProtoOutput = {
      ...makeProtoOutput(
        Array.from({ length: 8 }, (_, i) => ({
          filePath: `src/f${i}.tsx`,
          content: 'x',
          linesOfCode: 1,
        }))
      ),
      metadata: {
        filesCreated: 8,
        totalLinesOfCode: 240,
        stackUsed: 'React',
        committed: true,
      },
    };
    const r = buildProtoReasoning(proto);
    assert.notEqual(r.confidence.score, 88, 'PR-D: 88 heuristic should be removed');
    assert.equal(r.confidence.score, 70);
  });
});
