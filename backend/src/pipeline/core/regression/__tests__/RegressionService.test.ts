import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RegressionService } from '../RegressionService.js';
import type { PipelineState, ProtoOutput, TraceOutput } from '../../contracts/PipelineTypes.js';
import type { AgentActivitySelect } from '../../../db/agent-activity-schema.js';

const FIXED_NOW = new Date('2026-05-07T10:00:00Z');

function makeProto(files = 1): ProtoOutput {
  return {
    ok: true,
    branch: 'main',
    repo: 'me/r',
    repoUrl: '',
    files: Array.from({ length: files }, (_, i) => ({
      filePath: `f${i}.ts`,
      content: '',
      linesOfCode: 10,
    })),
    setupCommands: [],
    metadata: {
      filesCreated: files,
      totalLinesOfCode: files * 10,
      stackUsed: 'React',
      committed: true,
    },
  };
}

function makeTrace(): TraceOutput {
  return {
    ok: true,
    testFiles: [{ filePath: 't.spec.ts', content: '', testCount: 4 }],
    coverageMatrix: { 'ac-1': ['t1'] },
    testSummary: {
      totalTests: 4,
      coveragePercentage: 100,
      coveredCriteria: ['ac-1'],
      uncoveredCriteria: [],
    },
  };
}

function makePipeline(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: 'p-1',
    userId: 'u-1',
    stage: 'completed',
    traceEnabled: true,
    scribeConversation: [],
    metrics: { startedAt: FIXED_NOW, clarificationRounds: 0, retryCount: 0 },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function fakeActivity(action: string): AgentActivitySelect {
  return {
    id: 'a',
    pipelineId: 'p-1',
    agent: 'proto',
    action,
    reasoning: null,
    inputTokens: 0,
    outputTokens: 0,
    confidence: null,
    filesGenerated: null,
    testsPassed: null,
    testsFailed: null,
    specCompliance: null,
    assumptions: null,
    responseTimeMs: null,
    model: null,
    createdAt: FIXED_NOW,
  } as unknown as AgentActivitySelect;
}

describe('RegressionService', () => {
  it('returns verified_baseline for a root pipeline whose Trace passed', async () => {
    const pipeline = makePipeline({ traceOutput: makeTrace() });
    const svc = new RegressionService({
      store: { getById: async (id) => (id === pipeline.id ? pipeline : null) },
    });
    const report = await svc.getReport('p-1');
    assert.equal(report.status, 'verified_baseline');
    assert.equal(report.pipelineId, 'p-1');
    assert.equal(report.fixLoop.runs, 0);
  });

  it('reads parent pipeline baseline for an iteration child', async () => {
    const parent = makePipeline({ id: 'p-root', traceOutput: makeTrace() });
    const child = makePipeline({
      id: 'p-iter',
      stage: 'completed',
      protoOutput: makeProto(2),
      intermediateState: {
        parentPipelineId: 'p-root',
        iterationRequest: 'Logo değiştir',
      },
    });
    const svc = new RegressionService({
      store: {
        getById: async (id) => (id === parent.id ? parent : id === child.id ? child : null),
      },
    });
    const report = await svc.getReport('p-iter');
    assert.equal(report.parentPipelineId, 'p-root');
    assert.equal(report.iterationFilesChanged, 2);
    assert.equal(report.iterationRequest, 'Logo değiştir');
    assert.equal(report.baseline?.totalTests, 4);
  });

  it('counts FixLoop activity records and forwards them to the factory', async () => {
    const pipeline = makePipeline({ traceOutput: makeTrace() });
    const svc = new RegressionService({
      store: { getById: async () => pipeline },
      activityService: {
        listByPipeline: async () => [
          fakeActivity('fix_loop_iteration'),
          fakeActivity('fix_loop_iteration'),
          fakeActivity('spec_generated'),
        ],
      },
    });
    const report = await svc.getReport('p-1');
    assert.equal(report.fixLoop.runs, 2);
    assert.equal(report.status, 'self_healed');
  });

  it('throws when the pipeline does not exist', async () => {
    const svc = new RegressionService({ store: { getById: async () => null } });
    await assert.rejects(() => svc.getReport('missing'), /not found/);
  });
});
