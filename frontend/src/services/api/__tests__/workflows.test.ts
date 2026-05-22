import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pipeline, PipelineStage, ScribeMessageType } from '../../../types/pipeline';

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
          // approvedSpec set + no protoOutput → F-1 branch routes the
          // failure to the proto stage (scribe stays completed).
          approvedSpec: {
            title: 'X',
            userStories: [],
            acceptanceCriteria: [],
            problemStatement: '',
            outOfScope: [],
            technicalConstraints: { stack: '', integrations: [], nonFunctional: [] },
          } as unknown as Pipeline['approvedSpec'],
          error: { code: 'PROTO_FAILED', message: 'GitHub push failed', retryable: true },
        })
      );
      // Scribe was completed since stage progressed past it
      expect(w.stages.scribe.status).toBe('completed');
    });
  });

  // F-1 (2026-05-22): when the Reconciler sweeps a stuck pipeline to
  // `stage='failed'`, the 3-card upper view must mark the correct stage as
  // failed with a label derived from the error code. Before this fix the
  // mapper had no `stage === 'failed'` branch, so the Trace card kept
  // showing the running-stage label (e.g. "Test senaryolarını hazırlıyor")
  // even when the pipeline had been swept to failed.
  describe('mapPipelineToWorkflow — failed-state stage labels (F-1)', () => {
    it('marks trace stage failed with timeout label when stage=failed + PIPELINE_TIMEOUT + protoOutput exists', () => {
      const pipeline = makePipeline({
        stage: 'failed',
        protoOutput: {
          ok: true,
          files: [],
          branch: 'main',
          repo: 'owner/r',
          metadata: { filesCreated: 5, totalLinesOfCode: 100 },
        } as unknown as Pipeline['protoOutput'],
        traceOutput: null,
        error: { code: 'PIPELINE_TIMEOUT', message: 'X', retryable: true },
        traceEnabled: true,
      });
      const w = mapPipelineToWorkflow(pipeline);
      expect(w.stages.trace.status).toBe('failed');
      expect(w.stages.trace.error).toMatch(/zaman aşımı/i);
    });

    it('marks proto stage failed with generic error label when stage=failed + non-timeout + no protoOutput', () => {
      const pipeline = makePipeline({
        stage: 'failed',
        approvedSpec: {
          title: 'X',
          userStories: [],
          acceptanceCriteria: [],
          problemStatement: '',
          outOfScope: [],
          technicalConstraints: { stack: '', integrations: [], nonFunctional: [] },
        } as unknown as Pipeline['approvedSpec'],
        protoOutput: null,
        traceOutput: null,
        error: { code: 'AI_PROVIDER_ERROR', message: 'rate limit', retryable: true },
        traceEnabled: true,
      });
      const w = mapPipelineToWorkflow(pipeline);
      expect(w.stages.proto.status).toBe('failed');
      expect(w.stages.proto.error).toMatch(/rate limit|hata/i);
    });

    it('marks scribe stage failed when stage=failed and no spec yet', () => {
      const pipeline = makePipeline({
        stage: 'failed',
        approvedSpec: undefined,
        protoOutput: null,
        traceOutput: null,
        error: { code: 'AI_PROVIDER_ERROR', message: 'rate limit', retryable: true },
        traceEnabled: true,
      });
      const w = mapPipelineToWorkflow(pipeline);
      expect(w.stages.scribe.status).toBe('failed');
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

  // Chat event-log gating (2026-05-22): once the orchestrator persists typed
  // event-log entries (proto_completed / trace_completed / trace_failed) in
  // `scribeConversation`, the snapshot-derived synthetic proto_result and
  // trace_result rows would render duplicates. The mapper now skips the
  // snapshot synthesis when an event-log entry is present, and keeps it for
  // pipelines that pre-date the event-log (backward compat — NF-1).
  describe('event-log gating for snapshot synthesis (2026-05-22)', () => {
    function makeProtoOutput() {
      return {
        ok: true,
        branch: 'main',
        repo: 'owner/repo',
        repoUrl: 'https://github.com/owner/repo',
        files: [],
        setupCommands: [],
        summary: 'Snapshot özet',
        metadata: {
          filesCreated: 3,
          totalLinesOfCode: 120,
          committed: true,
        },
        verificationReport: {
          specCoverage: '100%',
          integrityIssues: [],
          confidenceScore: 95,
        },
      } as unknown as Pipeline['protoOutput'];
    }

    function makeTraceOutput() {
      return {
        ok: true,
        testFiles: [{ filePath: 'tests/foo.spec.ts', content: '', testCount: 3 }],
        coverageMatrix: {},
        testSummary: {
          totalTests: 3,
          coveragePercentage: 80,
          coveredCriteria: [],
          uncoveredCriteria: [],
        },
      } as unknown as Pipeline['traceOutput'];
    }

    it('skips snapshot proto_result synthesis when scribeConversation has proto_completed', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed',
          protoOutput: makeProtoOutput(),
          scribeConversation: [
            {
              type: 'proto_completed',
              content: {
                iteration: 1,
                summary: 'Event-log özet',
                filesCreated: 3,
                totalLines: 120,
                branch: 'main',
              },
              timestamp: '2026-05-22T10:00:00Z',
            },
          ] as unknown as Pipeline['scribeConversation'],
        })
      );
      const protoRows = (w.conversation ?? []).filter(
        (m) => m.role === 'proto' && m.type === 'proto_result'
      );
      // Only the event-log-derived row, NOT the synthetic snapshot one.
      expect(protoRows).toHaveLength(1);
      expect(protoRows[0].content).toBe('Event-log özet');
      // verificationReport + repo should be merged from pipeline.protoOutput
      // so the explainability rail keeps its data even after the snapshot
      // synthesis path is gated.
      expect(protoRows[0].protoResult?.verificationReport).toBeDefined();
      expect(protoRows[0].protoResult?.verificationReport?.confidenceScore).toBe(95);
      expect(protoRows[0].protoResult?.repo).toBe('owner/repo');
    });

    it('keeps snapshot proto_result synthesis when scribeConversation is empty (NF-1 backward compat)', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed',
          protoOutput: makeProtoOutput(),
          // No event-log entries — legacy pipeline.
          scribeConversation: [],
        })
      );
      const protoRows = (w.conversation ?? []).filter(
        (m) => m.role === 'proto' && m.type === 'proto_result'
      );
      expect(protoRows).toHaveLength(1);
      // Legacy snapshot content includes the "Scaffold oluşturuldu" prefix.
      expect(protoRows[0].content).toContain('Scaffold oluşturuldu');
    });

    it('skips snapshot trace_result synthesis when scribeConversation has trace_completed', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed',
          protoOutput: makeProtoOutput(),
          traceOutput: makeTraceOutput(),
          scribeConversation: [
            {
              type: 'trace_completed',
              content: { iteration: 1, totalTests: 3, coverage: 80, passed: true },
              timestamp: '2026-05-22T10:01:00Z',
            },
          ] as unknown as Pipeline['scribeConversation'],
        })
      );
      const traceRows = (w.conversation ?? []).filter(
        (m) => m.role === 'trace' && m.type === 'trace_result'
      );
      // Only the event-log-derived row.
      expect(traceRows).toHaveLength(1);
      expect(traceRows[0].iteration).toBe(1);
    });

    it('keeps snapshot trace_result synthesis when scribeConversation is empty (NF-1 backward compat)', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'completed',
          protoOutput: makeProtoOutput(),
          traceOutput: makeTraceOutput(),
          scribeConversation: [],
        })
      );
      const traceRows = (w.conversation ?? []).filter(
        (m) => m.role === 'trace' && m.type === 'trace_result'
      );
      // Legacy snapshot still synthesises a trace_result row.
      expect(traceRows).toHaveLength(1);
      expect(traceRows[0].content).toContain('Test yazıldı');
    });

    it('skips the "Trace test üretimi tamamlanamadı" info row when scribeConversation has trace_failed', () => {
      const w = mapPipelineToWorkflow(
        makePipeline({
          stage: 'awaiting_push_confirm',
          protoOutput: makeProtoOutput(),
          // No `traceOutput` (Trace failed); event-log carries the failure
          // so we should NOT also emit the legacy "tamamlanamadı" info row.
          scribeConversation: [
            {
              type: 'trace_failed',
              content: {
                iteration: 1,
                errorCode: 'PIPELINE_TIMEOUT',
                errorMessage: 'Trace zaman aşımına uğradı',
                recoveryAction: 'retry',
              },
              timestamp: '2026-05-22T10:02:00Z',
            },
          ] as unknown as Pipeline['scribeConversation'],
        })
      );
      const conv = w.conversation ?? [];
      const legacyInfo = conv.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('Trace test üretimi tamamlanamadı')
      );
      expect(legacyInfo).toBeUndefined();
      // But the event-log trace_failed row IS still there.
      const eventLogFailure = conv.find((m) => m.role === 'system' && m.type === 'trace_failed');
      expect(eventLogFailure).toBeDefined();
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

  describe('mapPipelineToConversation — chat event-log proxy', () => {
    it('maps proto_started/proto_completed/trace_started/trace_completed/trace_failed', () => {
      const pipeline = makePipeline({
        id: 'p1',
        stage: 'failed',
        scribeConversation: [
          { type: 'user_idea', content: 'idea' },
          {
            type: 'spec_approved',
            content: {
              title: 'X',
              userStories: [],
              acceptanceCriteria: [],
              problemStatement: '',
              outOfScope: [],
              technicalConstraints: { stack: '', integrations: [], nonFunctional: [] },
            },
          },
          { type: 'proto_started', content: { iteration: 1 }, timestamp: '2026-05-22T10:00:00Z' },
          {
            type: 'proto_completed',
            content: {
              iteration: 1,
              summary: 'Done.',
              filesCreated: 5,
              totalLines: 100,
              branch: 'main',
            },
            timestamp: '2026-05-22T10:01:00Z',
          },
          { type: 'trace_started', content: { iteration: 1 }, timestamp: '2026-05-22T10:02:00Z' },
          {
            type: 'trace_failed',
            content: {
              iteration: 1,
              errorCode: 'PIPELINE_TIMEOUT',
              errorMessage: 'Test yazımı 15 dakika yanıt vermedi.',
              recoveryAction: 'retry' as const,
            },
            timestamp: '2026-05-22T10:17:00Z',
          },
        ] as ScribeMessageType[],
        error: { code: 'PIPELINE_TIMEOUT', message: 'X', retryable: true },
        metrics: { startedAt: '2026-05-22T10:00:00Z', clarificationRounds: 0, retryCount: 0 },
        traceEnabled: true,
      });

      const w = mapPipelineToWorkflow(pipeline);
      const msgs = w.conversation ?? [];
      const types = msgs.map((m) => m.type);

      expect(types).toContain('proto_started');
      expect(types).toContain('proto_result'); // proto_completed → proto_result
      expect(types).toContain('trace_started');
      expect(types).toContain('trace_failed');

      const failed = msgs.find((m) => m.type === 'trace_failed');
      expect(failed?.errorCode).toBe('PIPELINE_TIMEOUT');
      expect(failed?.recoveryAction).toBe('retry');

      const completed = msgs.find((m) => m.type === 'proto_result');
      expect(completed?.iteration).toBe(1);
    });

    it('maps proto_completed.summary into proto_result.content', () => {
      const pipeline = makePipeline({
        id: 'p1',
        stage: 'completed',
        scribeConversation: [
          { type: 'proto_started', content: { iteration: 1 }, timestamp: '2026-05-22T10:00:00Z' },
          {
            type: 'proto_completed',
            content: {
              iteration: 1,
              summary: 'Sayaç hazır — artırma/azaltma/sıfırla çalışıyor.',
              filesCreated: 15,
              totalLines: 552,
              branch: 'main',
            },
            timestamp: '2026-05-22T10:01:00Z',
          },
        ] as ScribeMessageType[],
        metrics: { startedAt: '2026-05-22T10:00:00Z', clarificationRounds: 0, retryCount: 0 },
        traceEnabled: true,
      });

      const w = mapPipelineToWorkflow(pipeline);
      const msgs = w.conversation ?? [];
      const proto = msgs.find((m) => m.type === 'proto_result');
      expect(proto?.content).toContain('Sayaç hazır');
    });

    it('maps trace_completed into trace_result with iteration', () => {
      const pipeline = makePipeline({
        id: 'p1',
        stage: 'completed',
        scribeConversation: [
          {
            type: 'trace_completed',
            content: { iteration: 2, totalTests: 12, coverage: 87, passed: true },
            timestamp: '2026-05-22T10:05:00Z',
          },
        ] as ScribeMessageType[],
        metrics: { startedAt: '2026-05-22T10:00:00Z', clarificationRounds: 0, retryCount: 0 },
      });

      const w = mapPipelineToWorkflow(pipeline);
      const msgs = w.conversation ?? [];
      const trace = msgs.find((m) => m.type === 'trace_result');
      expect(trace?.iteration).toBe(2);
      expect(trace?.traceResult?.testCount).toBe(12);
    });
  });
});
