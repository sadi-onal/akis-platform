import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPipelineRoutes, type PipelineRoutesDeps } from '../../src/pipeline/api/pipeline.routes.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Mock Types ──────────────────────────────────

interface MockOrchestratorCall {
  method: string;
  args: unknown[];
}

// ─── Mock Orchestrator Factory ───────────────────

function createMockOrchestrator() {
  const calls: MockOrchestratorCall[] = [];

  const mockPipeline: Partial<PipelineState> = {
    id: 'pipe-1',
    userId: 'user-1',
    stage: 'awaiting_approval',
    title: 'Todo App',
    scribeConversation: [],
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
  };

  const orchestrator = {
    startPipeline: async (
      userId: string,
      input: unknown,
      model?: string,
      jiraConfig?: unknown,
      parentPipelineId?: string,
      skipScribe?: boolean,
      traceEnabled?: boolean,
    ) => {
      calls.push({
        method: 'startPipeline',
        args: [userId, input, model, jiraConfig, parentPipelineId, skipScribe, traceEnabled],
      });
      return { ...mockPipeline, id: 'pipe-new' };
    },
    listPipelines: async (userId: string) => {
      calls.push({ method: 'listPipelines', args: [userId] });
      return [mockPipeline, { ...mockPipeline, id: 'pipe-2' }];
    },
    getStatus: async (id: string) => {
      calls.push({ method: 'getStatus', args: [id] });
      return { ...mockPipeline, id };
    },
    sendMessage: async (id: string, message: string) => {
      calls.push({ method: 'sendMessage', args: [id, message] });
      return { ...mockPipeline, id, stage: 'scribe_generating' };
    },
    approveSpec: async (id: string, repoName: string, repoVisibility: string, spec?: unknown, jiraConfig?: unknown) => {
      calls.push({ method: 'approveSpec', args: [id, repoName, repoVisibility, spec, jiraConfig] });
      return { ...mockPipeline, id, stage: 'proto_building' };
    },
    rejectSpec: async (id: string, feedback: string) => {
      calls.push({ method: 'rejectSpec', args: [id, feedback] });
      return { ...mockPipeline, id, stage: 'awaiting_approval' };
    },
    retryStage: async (id: string) => {
      calls.push({ method: 'retryStage', args: [id] });
      return { ...mockPipeline, id };
    },
    skipTrace: async (id: string) => {
      calls.push({ method: 'skipTrace', args: [id] });
      return { ...mockPipeline, id, stage: 'completed_partial' };
    },
    cancelPipeline: async (id: string) => {
      calls.push({ method: 'cancelPipeline', args: [id] });
      return { ...mockPipeline, id, stage: 'cancelled' };
    },
    updateTitle: async (id: string, userId: string, title: string) => {
      calls.push({ method: 'updateTitle', args: [id, userId, title] });
      return { ...mockPipeline, id, title };
    },
    listChildren: async (id: string) => {
      calls.push({ method: 'listChildren', args: [id] });
      return [];
    },
    getLiveTokenUsage: (id: string, metrics?: Record<string, unknown>) => {
      calls.push({ method: 'getLiveTokenUsage', args: [id, metrics] });
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    },
    setModel: async (id: string, userId: string, model: string) => {
      calls.push({ method: 'setModel', args: [id, userId, model] });
      return { ...mockPipeline, id, model };
    },
  };

  return { orchestrator: orchestrator as unknown as PipelineRoutesDeps['orchestrator'], calls };
}

function makeRequest(
  params: Record<string, string>,
  body: Record<string, unknown>,
  userId = 'user-1',
) {
  return { params, body, _userId: userId };
}

function createRoutes() {
  const { orchestrator, calls } = createMockOrchestrator();
  const routes = createPipelineRoutes({
    orchestrator,
    getUserId: (req) => (req as { _userId: string })._userId,
  });
  return { routes, calls };
}

// ─── startPipeline ──────────────────────────────

describe('Pipeline Routes — startPipeline', () => {
  it('calls orchestrator.startPipeline with correct args', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.startPipeline(
      makeRequest({}, { idea: 'React ile bir todo uygulaması istiyorum, Google login olsun' }),
      {},
    );

    assert.ok((result as { pipeline: { id: string } }).pipeline.id);
    const startCalls = calls.filter((c) => c.method === 'startPipeline');
    assert.equal(startCalls.length, 1);
    assert.equal(startCalls[0].args[0], 'user-1');
    assert.deepEqual((startCalls[0].args[1] as { idea: string }).idea, 'React ile bir todo uygulaması istiyorum, Google login olsun');
  });

  // PR-A: traceEnabled wire-format regression. The schema default flipped from
  // false → true; this test pins the route-level contract so a future refactor
  // (e.g. switching to a request-validation middleware that bypasses the schema)
  // can't silently land tests-disabled-by-default again.
  it('defaults traceEnabled to true when body omits it (PR-A schema default)', async () => {
    const { routes, calls } = createRoutes();

    await routes.startPipeline(
      makeRequest({}, { idea: 'todo uygulaması yap' }),
      {},
    );

    const startCalls = calls.filter((c) => c.method === 'startPipeline');
    // Argument order: userId, scribeInput, model, jiraConfig, parentPipelineId, skipScribe, traceEnabled
    assert.equal(startCalls[0].args[6], true, 'traceEnabled should default to true when omitted');
  });

  it('respects explicit traceEnabled: false from body (user opt-out)', async () => {
    const { routes, calls } = createRoutes();

    await routes.startPipeline(
      makeRequest({}, { idea: 'todo uygulaması yap', traceEnabled: false }),
      {},
    );

    const startCalls = calls.filter((c) => c.method === 'startPipeline');
    assert.equal(startCalls[0].args[6], false);
  });

  it('respects explicit traceEnabled: true from body', async () => {
    const { routes, calls } = createRoutes();

    await routes.startPipeline(
      makeRequest({}, { idea: 'todo uygulaması yap', traceEnabled: true }),
      {},
    );

    const startCalls = calls.filter((c) => c.method === 'startPipeline');
    assert.equal(startCalls[0].args[6], true);
  });
});

// ─── listPipelines ──────────────────────────────

describe('Pipeline Routes — listPipelines', () => {
  it('calls orchestrator.listPipelines with user ID', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.listPipelines(makeRequest({}, {}));

    const pipelines = (result as { pipelines: unknown[] }).pipelines;
    assert.equal(pipelines.length, 2);
    const listCalls = calls.filter((c) => c.method === 'listPipelines');
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0].args[0], 'user-1');
  });
});

// ─── getStatus ──────────────────────────────────

describe('Pipeline Routes — getStatus', () => {
  it('calls orchestrator.getStatus with pipeline ID', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.getStatus(makeRequest({ id: 'pipe-42' }, {}));

    assert.equal((result as { pipeline: { id: string } }).pipeline.id, 'pipe-42');
    const statusCalls = calls.filter((c) => c.method === 'getStatus');
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].args[0], 'pipe-42');
  });
});

// ─── sendMessage ────────────────────────────────

describe('Pipeline Routes — sendMessage', () => {
  it('calls orchestrator.sendMessage with ID and message', async () => {
    const { routes, calls } = createRoutes();

    await routes.sendMessage(
      makeRequest({ id: 'pipe-1' }, { message: 'PostgreSQL istiyorum' }),
    );

    const msgCalls = calls.filter((c) => c.method === 'sendMessage');
    assert.equal(msgCalls.length, 1);
    assert.equal(msgCalls[0].args[0], 'pipe-1');
    assert.equal(msgCalls[0].args[1], 'PostgreSQL istiyorum');
  });
});

// ─── approveSpec ────────────────────────────────

describe('Pipeline Routes — approveSpec', () => {
  it('calls orchestrator.approveSpec with correct args', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.approveSpec(
      makeRequest({ id: 'pipe-1' }, { repoName: 'my-app', repoVisibility: 'private' }),
    );

    assert.equal((result as { pipeline: { stage: string } }).pipeline.stage, 'proto_building');
    const approveCalls = calls.filter((c) => c.method === 'approveSpec');
    assert.equal(approveCalls.length, 1);
    assert.equal(approveCalls[0].args[0], 'pipe-1');
    assert.equal(approveCalls[0].args[1], 'my-app');
    assert.equal(approveCalls[0].args[2], 'private');
  });
});

// ─── rejectSpec ─────────────────────────────────

describe('Pipeline Routes — rejectSpec', () => {
  it('calls orchestrator.rejectSpec with feedback', async () => {
    const { routes, calls } = createRoutes();

    await routes.rejectSpec(
      makeRequest({ id: 'pipe-1' }, { feedback: 'User story eksik' }),
    );

    const rejectCalls = calls.filter((c) => c.method === 'rejectSpec');
    assert.equal(rejectCalls.length, 1);
    assert.equal(rejectCalls[0].args[0], 'pipe-1');
    assert.equal(rejectCalls[0].args[1], 'User story eksik');
  });
});

// ─── retryStage ─────────────────────────────────

describe('Pipeline Routes — retryStage', () => {
  it('calls orchestrator.retryStage with pipeline ID', async () => {
    const { routes, calls } = createRoutes();

    await routes.retryStage(makeRequest({ id: 'pipe-1' }, {}));

    const retryCalls = calls.filter((c) => c.method === 'retryStage');
    assert.equal(retryCalls.length, 1);
    assert.equal(retryCalls[0].args[0], 'pipe-1');
  });
});

// ─── skipTrace ──────────────────────────────────

describe('Pipeline Routes — skipTrace', () => {
  it('calls orchestrator.skipTrace with pipeline ID', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.skipTrace(makeRequest({ id: 'pipe-1' }, {}));

    assert.equal((result as { pipeline: { stage: string } }).pipeline.stage, 'completed_partial');
    const skipCalls = calls.filter((c) => c.method === 'skipTrace');
    assert.equal(skipCalls.length, 1);
    assert.equal(skipCalls[0].args[0], 'pipe-1');
  });
});

// ─── cancelPipeline ─────────────────────────────

describe('Pipeline Routes — cancelPipeline', () => {
  it('calls orchestrator.cancelPipeline with pipeline ID', async () => {
    const { routes, calls } = createRoutes();

    const result = await routes.cancelPipeline(makeRequest({ id: 'pipe-1' }, {}));

    assert.equal((result as { pipeline: { stage: string } }).pipeline.stage, 'cancelled');
    const cancelCalls = calls.filter((c) => c.method === 'cancelPipeline');
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].args[0], 'pipe-1');
  });
});

// ─── Error propagation ──────────────────────────

describe('Pipeline Routes — Error propagation', () => {
  it('propagates orchestrator errors to caller', async () => {
    const { orchestrator } = createMockOrchestrator();
    (orchestrator as unknown as { getStatus: () => Promise<never> }).getStatus = async () => {
      throw new Error('Pipeline not found: pipe-999');
    };

    const routes = createPipelineRoutes({
      orchestrator,
      getUserId: (req) => (req as { _userId: string })._userId,
    });

    await assert.rejects(
      () => routes.getStatus(makeRequest({ id: 'pipe-999' }, {})),
      { message: /Pipeline not found/ },
    );
  });
});

// ─── setModel (issue #437) ──────────────────────

describe('Pipeline Routes — setModel', () => {
  it('calls orchestrator.setModel when model is in allowlist', async () => {
    const { routes, calls } = createRoutes();
    const result = await routes.setModel(
      makeRequest({ id: 'pipe-1' }, { model: 'claude-haiku-4-5-20251001' }),
    );
    assert.equal((result as { pipeline: { model?: string } }).pipeline.model, 'claude-haiku-4-5-20251001');
    const setCalls = calls.filter((c) => c.method === 'setModel');
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].args[0], 'pipe-1');
    assert.equal(setCalls[0].args[1], 'user-1');
    assert.equal(setCalls[0].args[2], 'claude-haiku-4-5-20251001');
  });

  it('rejects empty model string', async () => {
    const { routes } = createRoutes();
    await assert.rejects(
      () => routes.setModel(makeRequest({ id: 'pipe-1' }, { model: '' })),
      { message: /non-empty/ },
    );
  });

  it('rejects non-string model field', async () => {
    const { routes } = createRoutes();
    await assert.rejects(
      () => routes.setModel(makeRequest({ id: 'pipe-1' }, { model: 42 })),
      { message: /non-empty string/ },
    );
  });

  it('rejects model not in allowlist', async () => {
    const { routes } = createRoutes();
    await assert.rejects(
      () => routes.setModel(makeRequest({ id: 'pipe-1' }, { model: 'gpt-9000-unobtainium' })),
      { message: /not in the allowlist/ },
    );
  });

  it('trims whitespace before validating', async () => {
    const { routes, calls } = createRoutes();
    // PR-A: OpenAI excluded from allowlist; use an Anthropic model the picker accepts.
    await routes.setModel(makeRequest({ id: 'pipe-1' }, { model: '  claude-sonnet-4-6  ' }));
    const setCalls = calls.filter((c) => c.method === 'setModel');
    assert.equal(setCalls[setCalls.length - 1].args[2], 'claude-sonnet-4-6');
  });

  it('rejects model longer than 255 chars', async () => {
    const { routes } = createRoutes();
    await assert.rejects(
      () => routes.setModel(makeRequest({ id: 'pipe-1' }, { model: 'x'.repeat(300) })),
      { message: /too long/ },
    );
  });
});
