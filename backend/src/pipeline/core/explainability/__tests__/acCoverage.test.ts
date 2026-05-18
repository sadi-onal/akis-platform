import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAcCoverage } from '../acCoverage.js';
import type { ScribeOutput, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';

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

// ─── Tests ───────────────────────────────────────────────────

describe('buildAcCoverage', () => {
  it('returns empty report when no AC are defined', () => {
    const report = buildAcCoverage(makeScribeOutput([]), makeProtoOutput(), undefined);
    assert.equal(report.totalAcs, 0);
    assert.equal(report.staticCoveredCount, 0);
    assert.equal(report.dynamicCoveredCount, 0);
    assert.deepEqual(report.items, []);
  });

  it('returns empty report when scribeOutput is undefined', () => {
    const report = buildAcCoverage(undefined, makeProtoOutput(), undefined);
    assert.equal(report.totalAcs, 0);
    assert.deepEqual(report.items, []);
  });

  it('marks all AC uncovered when Proto produced no files', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'QR butonuna basıldığında', then: 'PNG indirir' },
      { id: 'ac-2', given: 'g', when: 'Form gönderildiğinde', then: 'sonuç gösterilir' },
    ]);
    const report = buildAcCoverage(scribe, makeProtoOutput([]), undefined);
    assert.equal(report.totalAcs, 2);
    assert.equal(report.staticCoveredCount, 0);
    assert.equal(report.items[0]!.staticCovered, false);
    assert.equal(report.items[0]!.coveringFiles.length, 0);
  });

  it('static-covers AC whose keywords appear in proto files', () => {
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
      {
        filePath: 'src/App.tsx',
        content: 'export default function App() { return <div/> }',
        linesOfCode: 10,
      },
    ]);

    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.totalAcs, 2);
    // AC-1 keywords ("png", "qr") should match QrForm.tsx
    const ac1 = report.items.find((i) => i.acId === 'ac-1')!;
    assert.equal(ac1.staticCovered, true, `expected ac-1 covered, got: ${JSON.stringify(ac1)}`);
    assert.ok(ac1.coveringFiles.includes('src/components/QrForm.tsx'));
    // AC-2 keywords ("geçmiş", "indirmeler", "listelenir", "eski") should NOT
    // match anything in the proto (App.tsx is generic boilerplate)
    const ac2 = report.items.find((i) => i.acId === 'ac-2')!;
    assert.equal(ac2.staticCovered, false);
    assert.equal(ac2.coveringFiles.length, 0);
  });

  it('caps coveringFiles list at 3 entries', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butonuna basıldığında', then: 'qrcode indirilir' },
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

  it('dynamic-covers AC via Trace coverageMatrix (authoritative)', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'QR butonu', then: 'PNG indir' },
    ]);
    const proto = makeProtoOutput([
      {
        filePath: 'src/QR.tsx',
        content: 'qrcode png',
        linesOfCode: 5,
      },
    ]);
    const trace = makeTraceOutput(
      [{ filePath: 'tests/qr.spec.ts', content: 'test("downloads PNG", () => {})', testCount: 1 }],
      { 'ac-1': ['downloads PNG'] }
    );
    const report = buildAcCoverage(scribe, proto, trace);
    assert.equal(report.items[0]!.staticCovered, true);
    assert.equal(report.items[0]!.dynamicCovered, true);
    assert.deepEqual(report.items[0]!.coveringTests, ['tests/qr.spec.ts']);
    assert.equal(report.dynamicCoveredCount, 1);
  });

  it('dynamic falls back to keyword match when coverageMatrix is empty', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butona basıldı', then: 'qrcode indirir' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode', linesOfCode: 5 },
    ]);
    const trace = makeTraceOutput([
      {
        filePath: 'tests/qr.spec.ts',
        content: 'test("renders qrcode")',
        testCount: 1,
      },
    ]);
    const report = buildAcCoverage(scribe, proto, trace);
    assert.equal(report.items[0]!.dynamicCovered, true);
    assert.deepEqual(report.items[0]!.coveringTests, ['tests/qr.spec.ts']);
  });

  it('handles partial coverage scenario across multiple AC', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'butona', then: 'qrcode üretir' },
      { id: 'ac-2', given: 'g', when: 'kaydet', then: 'png indirir' },
      { id: 'ac-3', given: 'g', when: 'paylaş', then: 'sosyal medya bağlantısı çıkar' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode generation logic', linesOfCode: 30 },
      { filePath: 'src/Download.tsx', content: 'png download', linesOfCode: 15 },
    ]);
    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.totalAcs, 3);
    assert.equal(report.staticCoveredCount, 2, `expected 2 covered, items=${JSON.stringify(report.items)}`);
    assert.equal(report.dynamicCoveredCount, 0);
    const ac3 = report.items.find((i) => i.acId === 'ac-3')!;
    assert.equal(ac3.staticCovered, false);
  });

  it('all-covered scenario when every AC keyword hits a Proto file', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'login', then: 'auth token döner' },
      { id: 'ac-2', given: 'g', when: 'logout', then: 'session sonlanır' },
    ]);
    const proto = makeProtoOutput([
      {
        filePath: 'src/auth.ts',
        content: 'login logout session token auth',
        linesOfCode: 50,
      },
    ]);
    const report = buildAcCoverage(scribe, proto, undefined);
    assert.equal(report.staticCoveredCount, 2);
    assert.ok(report.items.every((i) => i.staticCovered));
  });

  it('describeAc combines when + then for the description field', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'irrelevant given', when: 'tıklandığında', then: 'sonuç gösterilir' },
    ]);
    const report = buildAcCoverage(scribe, makeProtoOutput([]), undefined);
    assert.match(report.items[0]!.acDescription, /tıklandığında/);
    assert.match(report.items[0]!.acDescription, /sonuç/);
  });

  it('coverageMatrix test names map to the right test file paths', () => {
    const scribe = makeScribeOutput([
      { id: 'ac-1', given: 'g', when: 'w', then: 'qrcode üretir' },
    ]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode', linesOfCode: 1 },
    ]);
    const trace = makeTraceOutput(
      [
        {
          filePath: 'tests/qr.spec.ts',
          content: 'test("generates QR image", () => {})',
          testCount: 1,
        },
        {
          filePath: 'tests/other.spec.ts',
          content: 'test("unrelated")',
          testCount: 1,
        },
      ],
      { 'ac-1': ['generates QR image'] }
    );
    const report = buildAcCoverage(scribe, proto, trace);
    assert.deepEqual(report.items[0]!.coveringTests, ['tests/qr.spec.ts']);
  });

  it('coverageMatrix value falls back to raw test name when no file content matches', () => {
    const scribe = makeScribeOutput([{ id: 'ac-1', given: 'g', when: 'w', then: 'qrcode' }]);
    const proto = makeProtoOutput([
      { filePath: 'src/QR.tsx', content: 'qrcode', linesOfCode: 1 },
    ]);
    const trace = makeTraceOutput(
      [{ filePath: 'tests/qr.spec.ts', content: 'no match here', testCount: 0 }],
      { 'ac-1': ['phantom test name'] }
    );
    const report = buildAcCoverage(scribe, proto, trace);
    // Per spec: when coverageMatrix has entries we trust them — falls back
    // to the raw test name string when the file lookup misses.
    assert.deepEqual(report.items[0]!.coveringTests, ['phantom test name']);
  });
});
