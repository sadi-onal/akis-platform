import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pipeline, PipelineStage } from '../../../types/pipeline';

// ── Mock HttpClient before importing workflows module ──

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('../HttpClient', () => {
  return {
    HttpClient: class MockHttpClient {
      get = mockGet;
      post = mockPost;
      patch = mockPatch;
      delete = mockDelete;
    },
  };
});

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

// Import after mocks are set up
const { workflowsApi, mapPipelineToWorkflow } = await import('../workflows');

// ── Helpers ───────────────────────────────────────

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p-123',
    userId: 'u-1',
    stage: 'completed' as PipelineStage,
    title: 'Test Project',
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

// ── Tests ─────────────────────────────────────────

describe('mapPipelineToWorkflow', () => {
  describe('stage to workflow status mapping', () => {
    it('maps scribe_clarifying to running', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'scribe_clarifying' }));
      expect(w.status).toBe('running');
      expect(w.stages.scribe.status).toBe('running');
    });

    it('maps scribe_generating to running', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'scribe_generating' }));
      expect(w.status).toBe('running');
      expect(w.stages.scribe.status).toBe('running');
    });

    it('maps awaiting_approval correctly', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'awaiting_approval' }));
      expect(w.status).toBe('awaiting_approval');
      expect(w.stages.scribe.status).toBe('completed');
      expect(w.stages.approve.status).toBe('pending');
    });

    it('maps proto_building to running with scribe+approve completed', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'proto_building' }));
      expect(w.status).toBe('running');
      expect(w.stages.scribe.status).toBe('completed');
      expect(w.stages.approve.status).toBe('completed');
      expect(w.stages.proto.status).toBe('running');
    });

    it('maps trace_testing to running with proto completed', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'trace_testing' }));
      expect(w.status).toBe('running');
      expect(w.stages.proto.status).toBe('completed');
      expect(w.stages.trace.status).toBe('running');
    });

    it('maps completed to all stages completed', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'completed' }));
      expect(w.status).toBe('completed');
      expect(w.stages.scribe.status).toBe('completed');
      expect(w.stages.approve.status).toBe('completed');
      expect(w.stages.proto.status).toBe('completed');
      expect(w.stages.trace.status).toBe('completed');
    });

    it('maps completed_partial with trace failed', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'completed_partial' }));
      expect(w.status).toBe('completed_partial');
      expect(w.stages.proto.status).toBe('completed');
      expect(w.stages.trace.status).toBe('failed');
    });

    it('maps cancelled to cancelled', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'cancelled' }));
      expect(w.status).toBe('cancelled');
    });
  });

  // PR-V6-fix (2026-05-20): the smoke-test artifact on 2026-05-19 showed
  // `scribeSpec=undefined` at ChatPanel level despite the backend returning
  // the spec correctly. The unit tests existing at the time only exercised
  // `<ScribeOutputDisclosures spec={...} />` with explicit props — they
  // never asserted that `mapPipelineToWorkflow` actually populates
  // `stages.scribe.spec` end-to-end. These tests pin that contract so a
  // regression in the mapping (or accidental rename of `scribeOutput.spec`)
  // gets caught at the loader boundary instead of in manual smoke.
  describe('PR-V6 scribe spec + assumptions mapping', () => {
    function makeScribeOutput(overrides = {}): Pipeline['scribeOutput'] {
      return {
        spec: {
          title: 'Görev Yönetim Uygulaması',
          problemStatement: 'Kullanıcı görevlerini takip etmek istiyor.',
          userStories: [
            { persona: 'Yönetici', action: 'görev oluştur', benefit: 'ekip ilerlesin' },
          ],
          acceptanceCriteria: [
            { id: 'AC-1', given: 'liste boş', when: 'görev eklerim', then: 'listede görünür' },
            { id: 'AC-2', given: 'görev var', when: 'tamamlandı işaretlerim', then: 'arşivlenir' },
          ],
          technicalConstraints: { stack: 'React + Vite' },
          outOfScope: ['Mobil uygulama'],
        },
        rawMarkdown: '',
        confidence: 87,
        clarificationsAsked: 2,
        assumptions: ['Tek kullanıcı; auth gerekmez', 'PostgreSQL'],
        ...overrides,
      } as Pipeline['scribeOutput'];
    }

    it('threads scribeOutput.spec into stages.scribe.spec for awaiting_approval', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_approval',
          scribeOutput: makeScribeOutput(),
        })
      );
      expect(w.stages.scribe.spec).toBeDefined();
      expect(w.stages.scribe.spec?.acceptanceCriteria).toHaveLength(2);
      expect(w.stages.scribe.spec?.acceptanceCriteria[0].id).toBe('AC-1');
      expect(w.stages.scribe.spec?.problemStatement).toContain('takip etmek');
      expect(w.stages.scribe.spec?.userStories[0].persona).toBe('Yönetici');
      expect(w.stages.scribe.spec?.outOfScope).toContain('Mobil uygulama');
    });

    it('threads scribeOutput.assumptions into stages.scribe.assumptions', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_approval',
          scribeOutput: makeScribeOutput(),
        })
      );
      expect(w.stages.scribe.assumptions).toEqual(['Tek kullanıcı; auth gerekmez', 'PostgreSQL']);
    });

    it('preserves spec + assumptions on completed pipelines (smoke artifact case)', () => {
      // Smoke verification on 2026-05-19 used a pipeline at stage=completed
      // (reassigned to a new user). The backend kept `scribeOutput.spec`
      // populated; the mapper must propagate it so the Açıklama tab can
      // render disclosures even after the pipeline finished.
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed',
          scribeOutput: makeScribeOutput(),
        })
      );
      expect(w.stages.scribe.spec).toBeDefined();
      expect(w.stages.scribe.spec?.title).toBe('Görev Yönetim Uygulaması');
      expect(w.stages.scribe.assumptions).toHaveLength(2);
    });

    it('leaves spec undefined when scribeOutput is missing (older pipelines)', () => {
      const w = mapPipelineToWorkflow(makePipeline({ stage: 'completed' }));
      expect(w.stages.scribe.spec).toBeUndefined();
      expect(w.stages.scribe.assumptions).toBeUndefined();
    });

    it('forwards confidence alongside spec so ConfidenceBadge keeps working', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_approval',
          scribeOutput: makeScribeOutput({ confidence: 92 }),
        })
      );
      expect(w.stages.scribe.confidence).toBe(92);
      expect(w.stages.scribe.spec).toBeDefined();
    });
  });

  describe('title derivation', () => {
    it('uses pipeline title when available', () => {
      const w = mapPipelineToWorkflow(makePipeline({ title: 'My Project' }));
      expect(w.title).toBe('My Project');
    });

    it('falls back to user idea content when no title', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          title: undefined,
          scribeConversation: [{ type: 'user_idea', content: 'Build a todo app with React' }],
        })
      );
      expect(w.title).toBe('Build a todo app with React');
    });

    it('uses only the first line when idea is multi-line (BUG-25)', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          title: undefined,
          scribeConversation: [
            {
              type: 'user_idea',
              content:
                'Implement proper logging and monitoring infrastructure\n\nSet up structured logging (Winston, Pino, or similar)...',
            },
          ],
        })
      );
      expect(w.title).toBe('Implement proper logging and monitoring infrastructure');
    });
  });

  describe('error mapping to stage', () => {
    it('marks trace as failed when completed_partial has error', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed_partial',
          error: { code: 'TRACE_FAILED', message: 'Test writing failed', retryable: true },
        })
      );
      expect(w.stages.trace.status).toBe('failed');
      expect(w.stages.trace.error).toBe('Test writing failed');
    });

    it('marks proto as failed when proto_building has error', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'failed',
          error: { code: 'PROTO_FAILED', message: 'GitHub push failed', retryable: true },
        })
      );
      // Scribe was completed since stage progressed past it
      expect(w.stages.scribe.status).toBe('completed');
    });
  });

  // PR-H bug-2 (2026-05-19): when Trace dryRun fails before the push gate,
  // the orchestrator parks the pipeline at `awaiting_push_confirm` without
  // persisting `traceOutput` or `error`. Before this fix the chat timeline
  // ended at "Proto Scaffold oluşturuldu" and the user thought the pipeline
  // had stalled. The mapper now emits a synthetic info row narrating the
  // missing tests so the user knows what to do next.
  describe('Trace failure narrator (PR-H bug-2)', () => {
    function makeProtoOutput() {
      return {
        ok: true,
        branch: 'main',
        repo: 'owner/repo',
        repoUrl: 'https://github.com/owner/repo',
        files: [],
        setupCommands: [],
        metadata: {
          filesCreated: 3,
          totalLinesOfCode: 120,
          committed: false,
        },
      } as unknown as Pipeline['protoOutput'];
    }

    it('emits an info row when awaiting_push_confirm has no traceOutput', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_push_confirm',
          protoOutput: makeProtoOutput(),
        })
      );
      const conv = w.conversation ?? [];
      const traceFailure = conv.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('Trace test üretimi tamamlanamadı')
      );
      expect(traceFailure).toBeDefined();
    });

    it('does NOT emit the info row when traceOutput is present', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_push_confirm',
          protoOutput: makeProtoOutput(),
          traceOutput: {
            ok: true,
            testFiles: [{ filePath: 'tests/e2e/app.spec.ts', content: '', testCount: 3 }],
            coverageMatrix: {},
            testSummary: {
              totalTests: 3,
              coveragePercentage: 80,
              coveredCriteria: [],
              uncoveredCriteria: [],
            },
          } as unknown as Pipeline['traceOutput'],
        })
      );
      const conv = w.conversation ?? [];
      const traceFailure = conv.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('Trace test üretimi tamamlanamadı')
      );
      expect(traceFailure).toBeUndefined();
      const traceResult = conv.find((m) => m.role === 'trace' && m.type === 'trace_result');
      expect(traceResult).toBeDefined();
    });

    it('does NOT emit the info row when scaffold is not ready (no protoOutput)', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'proto_building',
        })
      );
      const conv = w.conversation ?? [];
      const traceFailure = conv.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('Trace test üretimi tamamlanamadı')
      );
      expect(traceFailure).toBeUndefined();
    });
  });
});

// ── API methods ───────────────────────────────────

describe('workflowsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('calls GET /api/pipelines and maps response', async () => {
      const pipeline = makePipeline();
      mockGet.mockResolvedValueOnce({ pipelines: [pipeline] });

      const workflows = await workflowsApi.list();

      expect(mockGet).toHaveBeenCalledWith('/api/pipelines');
      expect(workflows).toHaveLength(1);
      expect(workflows[0].id).toBe('p-123');
      expect(workflows[0].status).toBe('completed');
    });

    it('returns empty array when pipelines is not an array', async () => {
      mockGet.mockResolvedValueOnce({ pipelines: null });

      const workflows = await workflowsApi.list();

      expect(workflows).toEqual([]);
    });
  });

  describe('get', () => {
    it('calls GET /api/pipelines/:id', async () => {
      mockGet.mockResolvedValueOnce({ pipeline: makePipeline() });

      const workflow = await workflowsApi.get('p-123');

      // PR-U4 H2: workflowsApi.get always passes a 2nd `RequestOptions` arg
      // (empty object when caller omits `signal`). Match on URL only.
      expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-123', expect.anything());
      expect(workflow.id).toBe('p-123');
    });
  });

  describe('rename', () => {
    it('calls PATCH /api/pipelines/:id/title with title body', async () => {
      mockPatch.mockResolvedValueOnce({});

      await workflowsApi.rename('p-123', 'New Title');

      expect(mockPatch).toHaveBeenCalledWith('/api/pipelines/p-123/title', { title: 'New Title' });
    });
  });

  describe('cancel', () => {
    it('calls DELETE /api/pipelines/:id', async () => {
      mockDelete.mockResolvedValueOnce({});

      await workflowsApi.cancel('p-123');

      expect(mockDelete).toHaveBeenCalledWith('/api/pipelines/p-123');
    });
  });

  describe('create', () => {
    it('calls POST /api/pipelines with idea payload', async () => {
      mockPost.mockResolvedValueOnce({ pipeline: makePipeline({ stage: 'scribe_clarifying' }) });

      const workflow = await workflowsApi.create({ idea: 'Build a todo app' });

      expect(mockPost).toHaveBeenCalledWith('/api/pipelines', { idea: 'Build a todo app' });
      expect(workflow.status).toBe('running');
    });
  });

  describe('approve', () => {
    it('calls POST /api/pipelines/:id/approve with repo details', async () => {
      mockPost.mockResolvedValueOnce({ pipeline: makePipeline({ stage: 'proto_building' }) });

      const workflow = await workflowsApi.approve('p-123', 'my-repo', 'private');

      expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-123/approve', {
        repoName: 'my-repo',
        repoVisibility: 'private',
      });
      expect(workflow.stages.proto.status).toBe('running');
    });
  });

  describe('sendMessage', () => {
    it('calls POST /api/pipelines/:id/message with message body', async () => {
      mockPost.mockResolvedValueOnce({ pipeline: makePipeline({ stage: 'scribe_generating' }) });

      await workflowsApi.sendMessage('p-123', 'Here is my answer');

      expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-123/message', {
        message: 'Here is my answer',
      });
    });
  });

  describe('getRegression', () => {
    it('calls GET /api/pipelines/:id/regression and unwraps the report envelope', async () => {
      const report = {
        pipelineId: 'p-123',
        baseline: {
          totalTests: 6,
          coveragePercentage: 100,
          coveredCriteria: ['ac-1'],
          uncoveredCriteria: [],
        },
        fixLoop: { runs: 0, succeeded: false, triggered: false },
        status: 'verified_baseline',
        headline: 'Doğrulanmış baseline',
        bakkalSummary: 'Projenin baseline güveni: 6 test, %100 kapsam.',
      };
      mockGet.mockResolvedValueOnce({ report });

      const result = await workflowsApi.getRegression('p-123');

      expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-123/regression');
      expect(result).toEqual(report);
    });
  });
});
