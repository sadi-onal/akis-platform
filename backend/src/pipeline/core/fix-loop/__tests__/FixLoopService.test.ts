/**
 * FixLoopService — Self-healing Proto+Trace loop tests.
 *
 * Uses node:test runner (project standard).
 * Run: node --test --import tsx src/pipeline/core/fix-loop/__tests__/FixLoopService.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixLoopService } from '../FixLoopService.js';
import type { StructuredSpec, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';
import type { RunProtoFn, RunTraceFn } from '../FixLoopTypes.js';

// ─── Test Helpers ────────────────────────────────

function makeSpec(overrides?: Partial<StructuredSpec>): StructuredSpec {
  return {
    title: 'Test App',
    problemStatement: 'A test problem',
    userStories: [{ persona: 'User', action: 'does thing', benefit: 'gets value' }],
    acceptanceCriteria: [
      { id: 'ac-1', given: 'app loads', when: 'user visits', then: 'sees homepage' },
    ],
    technicalConstraints: { stack: 'React' },
    outOfScope: [],
    ...overrides,
  };
}

function makeProtoOutput(overrides?: Partial<ProtoOutput>): ProtoOutput {
  return {
    ok: true,
    branch: 'main',
    repo: 'test-repo',
    repoUrl: 'https://github.com/test/test-repo',
    files: [{ filePath: 'src/App.tsx', content: '// app', linesOfCode: 1 }],
    setupCommands: ['npm install'],
    metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React', committed: true },
    ...overrides,
  };
}

function makeTraceOutput(passed: boolean, overrides?: Partial<TraceOutput>): TraceOutput {
  return {
    ok: passed,
    testFiles: [{ filePath: 'tests/app.spec.ts', content: '// test', testCount: 3 }],
    coverageMatrix: { 'ac-1': ['tests/app.spec.ts'] },
    testSummary: {
      totalTests: 3,
      coveragePercentage: passed ? 100 : 50,
      coveredCriteria: passed ? ['ac-1'] : [],
      uncoveredCriteria: passed ? [] : ['ac-1'],
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────

describe('FixLoopService', () => {
  // ── 1. Happy path: first iteration passes ──────

  it('should succeed on the first iteration when tests pass', async () => {
    const spec = makeSpec();
    const proto: RunProtoFn = async () => makeProtoOutput();
    const trace: RunTraceFn = async () => makeTraceOutput(true);

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.totalIterations, 1);
    assert.strictEqual(result.terminationReason, 'tests_passed');
    assert.ok(result.finalProtoOutput);
    assert.ok(result.finalTraceOutput);
    assert.strictEqual(result.iterations[0].testsPassed, true);
    assert.strictEqual(result.iterations[0].iteration, 0);
  });

  // ── 2. Fix path: first 2 fail, 3rd passes ─────

  it('should succeed on third iteration after two failures', async () => {
    const spec = makeSpec();
    let callCount = 0;

    const proto: RunProtoFn = async (_spec, _feedback, _temperature) => {
      callCount++;
      return makeProtoOutput();
    };

    const trace: RunTraceFn = async () => {
      // Fail on calls 1 and 2, pass on call 3
      if (callCount <= 2) {
        return makeTraceOutput(false);
      }
      return makeTraceOutput(true);
    };

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.totalIterations, 3);
    assert.strictEqual(result.terminationReason, 'tests_passed');
    assert.strictEqual(result.iterations[0].testsPassed, false);
    assert.strictEqual(result.iterations[1].testsPassed, false);
    assert.strictEqual(result.iterations[2].testsPassed, true);
    // Verify feedback was passed on iterations 2 and 3
    assert.ok(result.iterations[0].failureReason);
    assert.ok(result.iterations[1].failureReason);
    assert.strictEqual(result.iterations[2].failureReason, undefined);
  });

  // ── 3. Max iterations: all 3 fail ─────────────

  it('should terminate with max_iterations when all iterations fail', async () => {
    const spec = makeSpec();
    const proto: RunProtoFn = async () => makeProtoOutput();
    const trace: RunTraceFn = async () => makeTraceOutput(false);

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.totalIterations, 3);
    assert.strictEqual(result.terminationReason, 'max_iterations');
    assert.strictEqual(result.finalProtoOutput, undefined);
    assert.strictEqual(result.finalTraceOutput, undefined);
    // All iterations should be recorded
    for (const iter of result.iterations) {
      assert.strictEqual(iter.testsPassed, false);
      assert.ok(iter.failureReason);
    }
  });

  // ── 4. Temperature escalation ──────────────────

  it('should escalate temperature by 0.1 per iteration', async () => {
    const spec = makeSpec();
    const temperatures: number[] = [];

    const proto: RunProtoFn = async (_spec, _feedback, temperature) => {
      temperatures.push(temperature ?? 0);
      return makeProtoOutput();
    };
    const trace: RunTraceFn = async () => makeTraceOutput(false);

    const service = new FixLoopService();
    await service.runFixLoop(spec, proto, trace);

    assert.deepStrictEqual(temperatures, [0, 0.1, 0.2]);
    // Also verify iteration records
  });

  // ── 5. Custom config ──────────────────────────

  it('should respect custom maxIterations and temperature settings', async () => {
    const spec = makeSpec();
    const temperatures: number[] = [];

    const proto: RunProtoFn = async (_spec, _feedback, temperature) => {
      temperatures.push(temperature ?? 0);
      return makeProtoOutput();
    };
    const trace: RunTraceFn = async () => makeTraceOutput(false);

    const service = new FixLoopService({
      maxIterations: 2,
      baseTemperature: 0.3,
      temperatureIncrement: 0.05,
    });
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.totalIterations, 2);
    assert.strictEqual(result.terminationReason, 'max_iterations');
    assert.deepStrictEqual(temperatures, [0.3, 0.35]);
  });

  // ── 6. Timeout handling ────────────────────────

  it('should terminate with timeout when an iteration exceeds the limit', async () => {
    const spec = makeSpec();

    const proto: RunProtoFn = async () => {
      // Simulate a very slow Proto call
      return new Promise((resolve) => {
        setTimeout(() => resolve(makeProtoOutput()), 5000);
      });
    };
    const trace: RunTraceFn = async () => makeTraceOutput(true);

    // Set a very short timeout to trigger the timeout path
    const service = new FixLoopService({ timeoutPerIteration: 50 });
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.terminationReason, 'timeout');
    assert.ok(result.errorMessage);
    assert.ok(result.errorMessage.includes('timed out'));
    assert.strictEqual(result.totalIterations, 1);
  });

  // ── 7. Error handling (callback throws) ────────

  it('should terminate with error when a callback throws', async () => {
    const spec = makeSpec();

    const proto: RunProtoFn = async () => {
      throw new Error('GitHub API rate limit exceeded');
    };
    const trace: RunTraceFn = async () => makeTraceOutput(true);

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.terminationReason, 'error');
    assert.ok(result.errorMessage);
    assert.ok(result.errorMessage.includes('GitHub API rate limit'));
    assert.strictEqual(result.totalIterations, 1);
  });

  // ── 8. Trace callback throws ──────────────────

  it('should terminate with error when trace callback throws', async () => {
    const spec = makeSpec();

    const proto: RunProtoFn = async () => makeProtoOutput();
    const trace: RunTraceFn = async () => {
      throw new Error('Trace AI call failed');
    };

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.terminationReason, 'error');
    assert.ok(result.errorMessage);
    assert.ok(result.errorMessage.includes('Trace AI call failed'));
  });

  // ── 9. Feedback is passed from previous failure ─

  it('should pass failure summary as feedback to Proto on subsequent iterations', async () => {
    const spec = makeSpec();
    const feedbacks: Array<string | undefined> = [];

    const proto: RunProtoFn = async (_spec, feedback) => {
      feedbacks.push(feedback);
      return makeProtoOutput();
    };

    let traceCallCount = 0;
    const trace: RunTraceFn = async () => {
      traceCallCount++;
      if (traceCallCount < 3) {
        return makeTraceOutput(false);
      }
      return makeTraceOutput(true);
    };

    const service = new FixLoopService();
    await service.runFixLoop(spec, proto, trace);

    // First iteration: no feedback
    assert.strictEqual(feedbacks[0], undefined);
    // Second iteration: feedback from first failure
    assert.ok(feedbacks[1]);
    assert.ok(feedbacks[1]!.includes('ac-1'));
    // Third iteration: feedback from second failure
    assert.ok(feedbacks[2]);
  });

  // ── 10. Duration tracking ─────────────────────

  it('should record positive durationMs for each iteration', async () => {
    const spec = makeSpec();
    const proto: RunProtoFn = async () => makeProtoOutput();
    const trace: RunTraceFn = async () => makeTraceOutput(true);

    const service = new FixLoopService();
    const result = await service.runFixLoop(spec, proto, trace);

    assert.strictEqual(result.iterations.length, 1);
    assert.ok(result.iterations[0].durationMs >= 0);
  });
});
