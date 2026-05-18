// P5b: route-level tests for GET /api/pipelines/:id/ai-calls
//
// Mirrors the structure of pipeline-regression-route.test.ts — we drive the
// route handler directly with a fake orchestrator, so neither the DB nor
// Fastify is in the loop. The DB-touching path is covered separately in
// ai-calls-service.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPipelineRoutes,
  type PipelineRoutesDeps,
} from '../../src/pipeline/api/pipeline.routes.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { AiCallEntry } from '../../src/pipeline/core/ai-calls/AiCallsTypes.js';

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

function fakeCall(overrides: Partial<AiCallEntry> = {}): AiCallEntry {
  return {
    id: 'call-1',
    callIndex: 0,
    provider: 'mock',
    model: 'mock-model',
    purpose: 'plan',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 1200,
    success: true,
    errorCode: null,
    timestamp: new Date('2026-05-18T12:00:00Z').toISOString(),
    systemPrompt: 'You are AKIS.',
    userPrompt: 'Build a TODO app',
    responseText: '{"plan":"steps"}',
    thinkingBlocks: null,
    toolCalls: null,
    ...overrides,
  };
}

function makeOrchestrator(
  opts: {
    pipeline?: PipelineState;
    calls?: AiCallEntry[];
    serviceError?: Error;
  } = {}
) {
  const pipeline = opts.pipeline ?? fakePipeline();
  return {
    getStatus: async (_id: string) => pipeline,
    getAiCallsService: () => ({
      getCalls: async (id: string) => {
        if (opts.serviceError) throw opts.serviceError;
        return (opts.calls ?? []).map((c) => ({ ...c, /* echo pipelineId via no-op */ })).filter(() => id);
      },
    }),
  } as unknown as PipelineRoutesDeps['orchestrator'];
}

function makeRequest(id: string, userId = 'user-1') {
  return { params: { id }, __pipelineUserId: userId } as unknown;
}

describe('pipeline route — getAiCalls', () => {
  it('returns calls from the service for the pipeline owner', async () => {
    const calls = [fakeCall(), fakeCall({ id: 'call-2', callIndex: 1, purpose: 'execute' })];
    const routes = createPipelineRoutes({
      orchestrator: makeOrchestrator({ calls }),
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    const response = (await routes.getAiCalls(makeRequest('pipe-1'))) as {
      calls: AiCallEntry[];
    };
    assert.equal(response.calls.length, 2);
    assert.equal(response.calls[0]!.id, 'call-1');
    assert.equal(response.calls[1]!.purpose, 'execute');
    // P5a content fields surface through
    assert.equal(response.calls[0]!.systemPrompt, 'You are AKIS.');
    assert.equal(response.calls[0]!.userPrompt, 'Build a TODO app');
  });

  it('returns an empty list when no calls are recorded for the pipeline', async () => {
    const routes = createPipelineRoutes({
      orchestrator: makeOrchestrator({ calls: [] }),
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    const response = (await routes.getAiCalls(makeRequest('pipe-1'))) as {
      calls: AiCallEntry[];
    };
    assert.deepEqual(response.calls, []);
  });

  it('throws 403 when caller does not own the pipeline', async () => {
    const orchestrator = makeOrchestrator({
      pipeline: fakePipeline({ userId: 'someone-else' }),
      calls: [fakeCall()],
    });
    const routes = createPipelineRoutes({
      orchestrator,
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    await assert.rejects(
      () => routes.getAiCalls(makeRequest('pipe-1', 'user-1')),
      (err: Error & { statusCode?: number }) => {
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  it('preserves null content fields (older rows pre-P5a)', async () => {
    const calls = [
      fakeCall({
        systemPrompt: null,
        userPrompt: null,
        responseText: null,
        thinkingBlocks: null,
        toolCalls: null,
      }),
    ];
    const routes = createPipelineRoutes({
      orchestrator: makeOrchestrator({ calls }),
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    const response = (await routes.getAiCalls(makeRequest('pipe-1'))) as {
      calls: AiCallEntry[];
    };
    assert.equal(response.calls.length, 1);
    assert.equal(response.calls[0]!.systemPrompt, null);
    assert.equal(response.calls[0]!.userPrompt, null);
    assert.equal(response.calls[0]!.responseText, null);
  });

  it('passes through structured thinking and tool-call blocks', async () => {
    const thinking = [{ type: 'thinking', text: 'Analyzing requirements...' }];
    const tools = [{ id: 'tool_1', name: 'github_search', input: { q: 'tests' } }];
    const calls = [fakeCall({ thinkingBlocks: thinking, toolCalls: tools })];
    const routes = createPipelineRoutes({
      orchestrator: makeOrchestrator({ calls }),
      getUserId: (req) => (req as Record<string, string>).__pipelineUserId,
    });
    const response = (await routes.getAiCalls(makeRequest('pipe-1'))) as {
      calls: AiCallEntry[];
    };
    assert.deepEqual(response.calls[0]!.thinkingBlocks, thinking);
    assert.deepEqual(response.calls[0]!.toolCalls, tools);
  });
});
