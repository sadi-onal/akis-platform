import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRegressionReport } from '../regressionFactory.js';
import type { PipelineState, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';

const FIXED_NOW = new Date('2026-05-07T10:00:00Z');

// ─── Fixtures ────────────────────────────────────────────────

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
    setupCommands: [],
    metadata: {
      filesCreated: 2,
      totalLinesOfCode: 35,
      stackUsed: 'React',
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
      coveragePercentage: 100,
      coveredCriteria: ['ac-1', 'ac-2'],
      uncoveredCriteria: [],
    },
    branch: 'akis/feat-1',
    ...overrides,
  };
}

function makePipeline(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: 'p-root',
    userId: 'u-1',
    stage: 'completed',
    traceEnabled: true,
    scribeConversation: [],
    metrics: {
      startedAt: FIXED_NOW,
      clarificationRounds: 0,
      retryCount: 0,
    },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function makeIterationChild(
  parentId: string,
  overrides: Partial<PipelineState> = {}
): PipelineState {
  return makePipeline({
    id: 'p-iter',
    stage: 'completed',
    intermediateState: {
      parentPipelineId: parentId,
      iterationRequest: 'Toplama tuşunun rengini yeşil yap',
    },
    protoOutput: makeProtoOutput({
      files: [{ filePath: 'src/App.tsx', content: '...', linesOfCode: 30 }],
    }),
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────

describe('buildRegressionReport — root pipeline', () => {
  it('marks status verified_baseline when Trace passed cleanly with no FixLoop', () => {
    const pipeline = makePipeline({
      traceOutput: makeTraceOutput(),
    });
    const r = buildRegressionReport({ pipeline });
    assert.equal(r.status, 'verified_baseline');
    assert.equal(r.fixLoop.triggered, false);
    assert.equal(r.fixLoop.runs, 0);
    assert.equal(r.iterationFilesChanged, undefined);
    assert.equal(r.iterationRequest, undefined);
    assert.equal(r.parentPipelineId, undefined);
    assert.ok(r.baseline);
    assert.equal(r.baseline!.totalTests, 6);
  });

  it('marks status no_baseline when Trace never ran (no traceOutput)', () => {
    const pipeline = makePipeline({ traceOutput: undefined });
    const r = buildRegressionReport({ pipeline });
    assert.equal(r.status, 'no_baseline');
    assert.equal(r.baseline, null);
    assert.match(r.bakkalSummary, /taban çizgisi yok/);
  });

  it('marks status degraded when Trace left uncovered AC', () => {
    const pipeline = makePipeline({
      stage: 'completed_partial',
      traceOutput: makeTraceOutput({
        testSummary: {
          totalTests: 6,
          coveragePercentage: 60,
          coveredCriteria: ['ac-1'],
          uncoveredCriteria: ['ac-2', 'ac-3'],
        },
      }),
    });
    const r = buildRegressionReport({ pipeline });
    assert.equal(r.status, 'degraded');
    assert.equal(r.baseline?.uncoveredCriteria.length, 2);
  });

  it('marks status self_healed when FixLoop ran and last iteration passed', () => {
    const pipeline = makePipeline({
      stage: 'completed',
      traceOutput: makeTraceOutput(),
    });
    const r = buildRegressionReport({
      pipeline,
      fixLoopActivityCount: 2,
      fixLoopSucceeded: true,
    });
    assert.equal(r.status, 'self_healed');
    assert.equal(r.fixLoop.runs, 2);
    assert.equal(r.fixLoop.succeeded, true);
    assert.equal(r.fixLoop.triggered, true);
  });

  it('marks status degraded when FixLoop triggered but failed', () => {
    const pipeline = makePipeline({
      stage: 'completed_partial',
      traceOutput: makeTraceOutput({
        testSummary: {
          totalTests: 4,
          coveragePercentage: 50,
          coveredCriteria: ['ac-1'],
          uncoveredCriteria: ['ac-2'],
        },
      }),
    });
    const r = buildRegressionReport({
      pipeline,
      fixLoopActivityCount: 3,
      fixLoopSucceeded: false,
    });
    assert.equal(r.status, 'degraded');
    assert.equal(r.fixLoop.runs, 3);
    assert.equal(r.fixLoop.succeeded, false);
  });
});

describe('buildRegressionReport — iteration child', () => {
  it('reads baseline from parent pipeline and iteration files from child', () => {
    const parent = makePipeline({ id: 'p-root', traceOutput: makeTraceOutput() });
    const child = makeIterationChild('p-root');
    const r = buildRegressionReport({ pipeline: child, parentPipeline: parent });
    assert.equal(r.parentPipelineId, 'p-root');
    assert.equal(r.iterationRequest, 'Toplama tuşunun rengini yeşil yap');
    assert.equal(r.iterationFilesChanged, 1);
    assert.ok(r.baseline);
    assert.equal(r.baseline!.totalTests, 6);
    assert.equal(r.status, 'verified_baseline');
  });

  it('marks status self_healed when parent FixLoop succeeded', () => {
    const parent = makePipeline({ id: 'p-root', traceOutput: makeTraceOutput() });
    const child = makeIterationChild('p-root');
    const r = buildRegressionReport({
      pipeline: child,
      parentPipeline: parent,
      fixLoopActivityCount: 1,
      fixLoopSucceeded: true,
    });
    assert.equal(r.status, 'self_healed');
    assert.equal(r.fixLoop.runs, 1);
  });

  it('marks status no_baseline when parent never ran Trace', () => {
    const parent = makePipeline({ id: 'p-root', traceOutput: undefined });
    const child = makeIterationChild('p-root');
    const r = buildRegressionReport({ pipeline: child, parentPipeline: parent });
    assert.equal(r.status, 'no_baseline');
    assert.equal(r.baseline, null);
    // iterationFilesChanged should still surface even without baseline.
    assert.equal(r.iterationFilesChanged, 1);
  });
});

describe('buildRegressionReport — bakkal copy', () => {
  it('bakkalSummary mentions baseline test counts when present', () => {
    const pipeline = makePipeline({ traceOutput: makeTraceOutput() });
    const r = buildRegressionReport({ pipeline });
    assert.match(r.bakkalSummary, /6 testle/);
    assert.match(r.bakkalSummary, /%100/);
  });

  it('bakkalSummary names the file count for iteration children', () => {
    const parent = makePipeline({ id: 'p-root', traceOutput: makeTraceOutput() });
    const child = makeIterationChild('p-root');
    const r = buildRegressionReport({ pipeline: child, parentPipeline: parent });
    assert.match(r.bakkalSummary, /1 dosyaya dokundu/);
  });

  it('headline is short (< 80 chars) and Turkish', () => {
    const pipeline = makePipeline({ traceOutput: makeTraceOutput() });
    const r = buildRegressionReport({ pipeline });
    assert.ok(r.headline.length < 80, `headline too long: ${r.headline.length}`);
    // Turkish spelling cue — should contain non-ASCII or Turkish keywords.
    assert.ok(
      /[ığüşöçĞÜŞÖÇİ]/.test(r.headline) || /Doğrulanmış|baseline|kapsam/.test(r.headline),
      `headline not Turkish: ${r.headline}`
    );
  });

  it('FixLoop section says "düzeldi" when succeeded, "başaramadı" when failed, omits when never ran', () => {
    const pipeline = makePipeline({ traceOutput: makeTraceOutput() });
    const success = buildRegressionReport({
      pipeline,
      fixLoopActivityCount: 1,
      fixLoopSucceeded: true,
    });
    assert.match(success.bakkalSummary, /kendini düzeltti/);

    const fail = buildRegressionReport({
      pipeline,
      fixLoopActivityCount: 1,
      fixLoopSucceeded: false,
    });
    assert.match(fail.bakkalSummary, /başaramadı/);

    const never = buildRegressionReport({ pipeline });
    assert.ok(!/AKIS başlangıçta/.test(never.bakkalSummary));
  });
});
