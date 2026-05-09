import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPipelineRoutes,
  type PipelineRoutesDeps,
} from '../../src/pipeline/api/pipeline.routes.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { RegressionReport } from '../../src/pipeline/core/regression/RegressionTypes.js';

// ─── Helpers ─────────────────────────────────────────────────

function fakePipeline(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: 'pipe-1',
    userId: 'user-1',
    stage: 'completed',
    traceEnabled: true,
    scribeConversation: [],
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeReport(): RegressionReport {
  return {
    pipelineId: 'pipe-1',
    baseline: {
      totalTests: 6,
      coveragePercentage: 100,
      coveredCriteria: ['ac-1'],
      uncoveredCriteria: [],
    },
    fixLoop: { runs: 0, succeeded: false, triggered: false },
    status: 'verified_baseline',
    headline: 'Doğrulanmış baseline: 6 test, %100 kapsam',
    bakkalSummary: 'Projenin baseline güveni: 6 testle %100 kapsam.',
  };
}

function makeOrchestrator(
  opts: {
    pipeline?: PipelineState;
    reportError?: Error;
  } = {}
) {
  const pipeline = opts.pipeline ?? fakePipeline();
  return {
    getStatus: async (_id: string) => pipeline,
    getRegressionService: () => ({
      getReport: async (id: string) => {
        if (opts.reportError) throw opts.reportError;
        return { ...fakeReport(), pipelineId: id };
      },
    }),
  } as unknown as PipelineRoutesDeps['orchestrator'];
}

function makeRequest(id: string, userId = 'user-1') {
  return { params: { id }, __pipelineUserId: userId } as unknown;
}

// ─── Tests ───────────────────────────────────────────────────

describe('pipeline route — getRegression', () => {
  it('returns the report from the orchestrator service', async () => {
    const routes = createPipelineRoutes({
      orchestrator: makeOrchestrator(),
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    const response = (await routes.getRegression(makeRequest('pipe-1'))) as {
      report: RegressionReport;
    };
    assert.equal(response.report.pipelineId, 'pipe-1');
    assert.equal(response.report.status, 'verified_baseline');
    assert.equal(response.report.baseline?.totalTests, 6);
  });

  it('throws 403 when caller does not own the pipeline', async () => {
    const orchestrator = makeOrchestrator({
      pipeline: fakePipeline({ userId: 'someone-else' }),
    });
    const routes = createPipelineRoutes({
      orchestrator,
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    await assert.rejects(
      () => routes.getRegression(makeRequest('pipe-1', 'user-1')),
      (err: Error & { statusCode?: number }) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });
});
