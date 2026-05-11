import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pipeline, PipelineStage, ScribeOutput, ProtoOutput, TraceOutput } from '../../../types/pipeline';
import type { ChatAttachment } from '../../../components/chat/ChatInput';

// ── Mock HttpClient ────────────────────────────────
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
const mockPostFormData = vi.fn();

vi.mock('../HttpClient', () => ({
  HttpClient: class MockHttpClient {
    get = mockGet;
    post = mockPost;
    patch = mockPatch;
    delete = mockDelete;
    postFormData = mockPostFormData;
  },
}));

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

const { workflowsApi, mapPipelineToWorkflow } = await import('../workflows');

// ── Helpers ────────────────────────────────────────
function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p-1',
    userId: 'u-1',
    stage: 'completed' as PipelineStage,
    title: 'T',
    scribeConversation: [],
    metrics: {
      startedAt: '2024-01-01T00:00:00.000Z',
      clarificationRounds: 0,
      retryCount: 0,
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeScribeOutput(): ScribeOutput {
  return {
    spec: {
      title: 'Spec',
      problemStatement: 'P',
      userStories: [{ persona: 'user', action: 'click', benefit: 'value' }],
      acceptanceCriteria: [{ id: 'ac-1', given: 'g', when: 'w', then: 't' }],
      technicalConstraints: {},
      outOfScope: [],
    },
    rawMarkdown: '',
    confidence: 0.9,
    clarificationsAsked: 0,
  };
}

function makeProtoOutput(): ProtoOutput {
  return {
    ok: true,
    branch: 'feat/main',
    repo: 'me/test',
    repoUrl: 'https://github.com/me/test',
    files: [{ filePath: 'src/index.ts', content: 'x', linesOfCode: 1 }],
    setupCommands: [],
    metadata: { filesCreated: 1, totalLinesOfCode: 1 },
  } as ProtoOutput;
}

function makeTraceOutput(): TraceOutput {
  return {
    testFiles: [{ filePath: 'src/index.test.ts', testCount: 3, content: '' }],
    testSummary: {
      totalTests: 3,
      coveragePercentage: 90,
      coveredCriteria: ['ac-1'],
      uncoveredCriteria: [],
    },
    traceability: [],
  } as unknown as TraceOutput;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── mapPipelineToWorkflow output enrichment ────────
describe('mapPipelineToWorkflow output enrichment', () => {
  it('maps scribeOutput.spec into stages.scribe.spec with persona aliases', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ stage: 'awaiting_approval', scribeOutput: makeScribeOutput() }),
    );
    expect(w.stages.scribe.confidence).toBe(0.9);
    expect(w.stages.scribe.spec?.userStories[0].as).toBe('user');
    expect(w.stages.scribe.spec?.userStories[0].iWant).toBe('click');
    expect(w.stages.scribe.spec?.userStories[0].soThat).toBe('value');
  });

  it('maps protoOutput into stages.proto with file paths', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ stage: 'completed', protoOutput: makeProtoOutput() }),
    );
    expect(w.stages.proto.branch).toBe('feat/main');
    expect(w.stages.proto.repo).toBe('me/test');
    expect(w.stages.proto.files).toEqual(['src/index.ts']);
  });

  it('maps traceOutput into stages.trace with coverage as %-string', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ stage: 'completed', traceOutput: makeTraceOutput() }),
    );
    expect(w.stages.trace.tests).toBe(3);
    expect(w.stages.trace.coverage).toBe('90%');
  });

  it('respects metrics.scribeCompletedAt / approvedAt / protoCompletedAt / traceCompletedAt', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        stage: 'completed',
        metrics: {
          startedAt: '2024-01-01T00:00:00.000Z',
          clarificationRounds: 0,
          retryCount: 0,
          scribeCompletedAt: '2024-01-02T00:00:00.000Z',
          approvedAt: '2024-01-03T00:00:00.000Z',
          protoCompletedAt: '2024-01-04T00:00:00.000Z',
          traceCompletedAt: '2024-01-05T00:00:00.000Z',
        },
      }),
    );
    expect(w.stages.scribe.endTime).toBe('2024-01-02T00:00:00.000Z');
    expect(w.stages.approve.status).toBe('completed');
    expect(w.stages.approve.endTime).toBe('2024-01-03T00:00:00.000Z');
    expect(w.stages.proto.endTime).toBe('2024-01-04T00:00:00.000Z');
    expect(w.stages.trace.endTime).toBe('2024-01-05T00:00:00.000Z');
  });

  it('puts error message onto trace stage when stage is trace_testing', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        stage: 'trace_testing',
        error: { code: 'TRACE_FAILED', message: 'tests crashed', retryable: false },
      }),
    );
    expect(w.stages.trace.status).toBe('failed');
    expect(w.stages.trace.error).toBe('tests crashed');
  });

  it('puts error onto proto stage when stage is proto_building', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        stage: 'proto_building',
        error: { code: 'PROTO_FAILED', message: 'push failed', retryable: true },
      }),
    );
    expect(w.stages.proto.status).toBe('failed');
    expect(w.stages.proto.error).toBe('push failed');
  });

  it('puts error onto scribe stage when scribe is still running', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        stage: 'scribe_generating',
        error: { code: 'SCRIBE_FAILED', message: 'llm down', retryable: false },
      }),
    );
    expect(w.stages.scribe.status).toBe('failed');
    expect(w.stages.scribe.error).toBe('llm down');
  });

  it('falls back to "Isimsiz Is Akisi" when no title and conversation is empty', () => {
    const w = mapPipelineToWorkflow(makePipeline({ title: undefined, scribeConversation: [] }));
    expect(w.title).toBe('Isimsiz Is Akisi');
  });

  it('falls back to "Isimsiz Is Akisi" when first conversation entry is not user_idea', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        title: undefined,
        scribeConversation: [{ type: 'clarification', content: { questions: [] } } as never],
      }),
    );
    expect(w.title).toBe('Isimsiz Is Akisi');
  });

  it('falls back to "Isimsiz Is Akisi" when user_idea content is not a string', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        title: undefined,
        scribeConversation: [{ type: 'user_idea', content: { foo: 'bar' } } as never],
      }),
    );
    expect(w.title).toBe('Isimsiz Is Akisi');
  });

  it('truncates titles longer than 60 characters', () => {
    const longIdea = 'a'.repeat(70);
    const w = mapPipelineToWorkflow(
      makePipeline({
        title: undefined,
        scribeConversation: [{ type: 'user_idea', content: longIdea }],
      }),
    );
    expect(w.title.length).toBe(60);
  });

  it('uses traceEnabled=false to leave trace stage idle on completion', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ stage: 'completed', traceEnabled: false }),
    );
    expect(w.stages.trace.status).toBe('idle');
  });

  it('exposes pipeline.model and traceEnabled on the workflow root', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ model: 'gpt-4', traceEnabled: true, modelLockedAt: '2024-01-02T00:00:00Z' }),
    );
    expect(w.model).toBe('gpt-4');
    expect(w.traceEnabled).toBe(true);
    expect(w.modelLockedAt).toBe('2024-01-02T00:00:00Z');
  });
});

// ── mapConversation full coverage ──────────────────
describe('mapPipelineToWorkflow conversation mapping', () => {
  it('renders user_idea entry as user message', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        scribeConversation: [{ type: 'user_idea', content: 'build a todo' }],
      }),
    );
    expect(w.conversation[0]).toMatchObject({ role: 'user', type: 'message', content: 'build a todo' });
  });

  it('renders clarification entries with the questions array', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        scribeConversation: [
          {
            type: 'clarification',
            content: { questions: [{ id: 'q1', question: 'why?', reason: 'context' }] },
          },
        ],
      }),
    );
    expect(w.conversation[0]).toMatchObject({
      role: 'scribe',
      type: 'clarification',
      questions: [{ id: 'q1', question: 'why?', reason: 'context' }],
    });
  });

  it('renders user_answer and user_note as user messages', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        scribeConversation: [
          { type: 'user_answer', content: 'because' },
          { type: 'user_note', content: 'also remember this' },
        ],
      }),
    );
    expect(w.conversation.map((c) => c.role)).toEqual(['user', 'user']);
    expect(w.conversation[0].content).toBe('because');
    expect(w.conversation[1].content).toBe('also remember this');
  });

  it('renders spec_draft as scribe spec message', () => {
    const so = makeScribeOutput();
    const w = mapPipelineToWorkflow(
      makePipeline({ scribeConversation: [{ type: 'spec_draft', content: so }] }),
    );
    expect(w.conversation[0]).toMatchObject({
      role: 'scribe',
      type: 'spec',
      confidence: 0.9,
    });
  });

  it('skips spec_draft when spec field is missing', () => {
    const empty = { rawMarkdown: '', confidence: 0, clarificationsAsked: 0 } as unknown as ScribeOutput;
    const w = mapPipelineToWorkflow(
      makePipeline({ scribeConversation: [{ type: 'spec_draft', content: empty }] }),
    );
    expect(w.conversation).toHaveLength(0);
  });

  it('renders spec_approved as system message', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        scribeConversation: [{ type: 'spec_approved', content: makeScribeOutput().spec }],
      }),
    );
    expect(w.conversation[0]).toMatchObject({ role: 'system', content: 'Spec onaylandı — Proto aşamasına geçiliyor.' });
  });

  it('renders spec_rejected as system message containing the feedback', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        scribeConversation: [{ type: 'spec_rejected', content: { feedback: 'not enough detail' } }],
      }),
    );
    expect(w.conversation[0].content).toContain('Spec reddedildi');
    expect(w.conversation[0].content).toContain('not enough detail');
  });

  it('appends a proto_result message when protoOutput.ok is true', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({
        protoOutput: makeProtoOutput(),
        scribeConversation: [],
      }),
    );
    const protoMsg = w.conversation.find((c) => c.role === 'proto');
    expect(protoMsg).toBeDefined();
    expect(protoMsg?.content).toContain('Scaffold oluşturuldu');
  });

  it('appends a trace_result message when traceOutput is present', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ traceOutput: makeTraceOutput() }),
    );
    const traceMsg = w.conversation.find((c) => c.role === 'trace');
    expect(traceMsg).toBeDefined();
    expect(traceMsg?.content).toContain('Test yazıldı');
  });

  it('returns empty array when scribeConversation is not an array', () => {
    const w = mapPipelineToWorkflow(
      makePipeline({ scribeConversation: null as never }),
    );
    expect(w.conversation).toEqual([]);
  });
});

// ── workflowsApi extra endpoints ───────────────────
describe('workflowsApi extra endpoints', () => {
  it('create with attachments uses postFormData', async () => {
    mockPostFormData.mockResolvedValueOnce({ pipeline: makePipeline() });
    const att: ChatAttachment = {
      id: 'a-1',
      file: new File(['x'], 'a.txt', { type: 'text/plain' }),
      name: 'a.txt',
      size: 1,
      type: 'text/plain',
    } as unknown as ChatAttachment;
    await workflowsApi.create(
      {
        idea: 'build it',
        context: 'ctx',
        targetStack: 'react',
        model: 'gpt-4',
        traceEnabled: true,
        skipScribe: false,
        existingRepo: { owner: 'me', repo: 'r', branch: 'main' },
        parentPipelineId: 'parent-1',
      },
      [att],
    );
    expect(mockPostFormData).toHaveBeenCalledTimes(1);
    const [url, fd] = mockPostFormData.mock.calls[0];
    expect(url).toBe('/api/pipelines');
    expect(fd).toBeInstanceOf(FormData);
    expect((fd as FormData).get('idea')).toBe('build it');
    expect((fd as FormData).get('context')).toBe('ctx');
    expect((fd as FormData).get('model')).toBe('gpt-4');
    expect((fd as FormData).get('traceEnabled')).toBe('true');
    expect((fd as FormData).get('parentPipelineId')).toBe('parent-1');
    expect((fd as FormData).getAll('files')).toHaveLength(1);
  });

  it('create without attachments uses regular POST', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.create({ idea: 'plain idea' });
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines', { idea: 'plain idea' });
  });

  it('approve forwards jiraConfig and cucumberEnabled when supplied', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.approve('p-1', 'repo', 'public', {
      jiraConfig: { projectKey: 'JIRA', enabled: true },
      cucumberEnabled: true,
    });
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/approve', {
      repoName: 'repo',
      repoVisibility: 'public',
      jiraConfig: { projectKey: 'JIRA', enabled: true },
      cucumberEnabled: true,
    });
  });

  it('reject POSTs feedback when present', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.reject('p-1', 'too vague');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/reject', { feedback: 'too vague' });
  });

  it('reject POSTs undefined body when no feedback', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.reject('p-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/reject', undefined);
  });

  it('retry POSTs to /retry', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.retry('p-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/retry');
  });

  it('skipTrace POSTs to /skip-trace', async () => {
    mockPost.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.skipTrace('p-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/skip-trace');
  });

  it('toggleTrace PATCHes /trace-toggle with enabled flag', async () => {
    mockPatch.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.toggleTrace('p-1', true);
    expect(mockPatch).toHaveBeenCalledWith('/api/pipelines/p-1/trace-toggle', { enabled: true });
  });

  it('updateModel PATCHes /model with new model id', async () => {
    mockPatch.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.updateModel('p-1', 'gpt-4o');
    expect(mockPatch).toHaveBeenCalledWith('/api/pipelines/p-1/model', { model: 'gpt-4o' });
  });

  it('listSupportedModels honors the provider query string', async () => {
    mockGet.mockResolvedValueOnce({ provider: 'anthropic', models: [] });
    await workflowsApi.listSupportedModels('anthropic');
    expect(mockGet).toHaveBeenCalledWith('/api/ai/supported-models?provider=anthropic');
  });

  it('listSupportedModels omits the query string when no provider', async () => {
    mockGet.mockResolvedValueOnce({ provider: 'openai', models: [] });
    await workflowsApi.listSupportedModels();
    expect(mockGet).toHaveBeenCalledWith('/api/ai/supported-models');
  });

  it('getExplanation GETs /explanation and unwraps the envelope', async () => {
    mockGet.mockResolvedValueOnce({ explanation: { stages: [], narrative: 'x' } });
    const res = await workflowsApi.getExplanation('p-1');
    expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-1/explanation');
    expect(res).toEqual({ stages: [], narrative: 'x' });
  });

  it('poll GETs /api/pipelines/:id', async () => {
    mockGet.mockResolvedValueOnce({ pipeline: makePipeline() });
    await workflowsApi.poll('p-1');
    expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-1');
  });

  it('sendMessage with attachments uses postFormData', async () => {
    mockPostFormData.mockResolvedValueOnce({ pipeline: makePipeline() });
    const att: ChatAttachment = {
      id: 'x',
      file: new File(['x'], 'a.txt'),
      name: 'a.txt',
      size: 1,
      type: 'text/plain',
    } as unknown as ChatAttachment;
    await workflowsApi.sendMessage('p-1', 'msg', [att]);
    expect(mockPostFormData).toHaveBeenCalledWith('/api/pipelines/p-1/message', expect.any(FormData));
  });

  it('getAllFiles GETs /files-all', async () => {
    mockGet.mockResolvedValueOnce({ files: { 'a.ts': 'x' }, title: 'T' });
    const res = await workflowsApi.getAllFiles('p-1');
    expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-1/files-all');
    expect(res.title).toBe('T');
  });

  it('getProtoFiles returns res.files on success', async () => {
    mockGet.mockResolvedValueOnce({ files: { 'a.ts': 'x' } });
    const res = await workflowsApi.getProtoFiles('p-1');
    expect(res).toEqual({ 'a.ts': 'x' });
  });

  it('getProtoFiles swallows errors and returns {}', async () => {
    mockGet.mockRejectedValueOnce(new Error('404'));
    const res = await workflowsApi.getProtoFiles('p-1');
    expect(res).toEqual({});
  });

  it('getProtoFiles returns {} when files key is missing', async () => {
    mockGet.mockResolvedValueOnce({});
    const res = await workflowsApi.getProtoFiles('p-1');
    expect(res).toEqual({});
  });

  it('getFileContent GETs /files/<path>', async () => {
    mockGet.mockResolvedValueOnce({ path: 'a', content: 'x', language: 'ts', lines: 1, agent: 'proto' });
    await workflowsApi.getFileContent('p-1', 'src/a.ts');
    expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-1/files/src/a.ts');
  });
});
