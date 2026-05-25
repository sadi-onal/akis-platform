/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the Kademe-1 orchestrator helper modules.
 *
 * Covers stateHelpers, metricsHelpers, activityHelpers, and criticHelpers --
 * the four modules whose functions are amenable to isolated unit testing
 * (pure or with simple mock dependencies).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTerminalStage,
  deriveRepoName,
  assertStage,
  reconstructScribeState,
  getPipeline,
  isCancelled,
  validateGitHubAccess,
} from '../../src/pipeline/core/orchestrator/helpers/stateHelpers.js';

import {
  createTokenCallback,
  flushTokenUsage,
  getLiveTokenUsage,
  markStageStarted,
  getStageDurationMs,
  clearStageStarts,
} from '../../src/pipeline/core/orchestrator/helpers/metricsHelpers.js';
import type { TokenAccumulator } from '../../src/pipeline/core/orchestrator/helpers/metricsHelpers.js';

import {
  countPriorEvents,
  buildSubStepsForStage,
  buildScribeCompletedEvent,
} from '../../src/pipeline/core/orchestrator/helpers/activityHelpers.js';

import {
  evaluateTraceIterateLoop,
  evaluateCriticIterateLoop,
} from '../../src/pipeline/core/orchestrator/helpers/criticHelpers.js';

import type {
  PipelineState,
  PipelineStage,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ── Shared fixture helpers ───────────────────────────────────

function makePipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: 'pipe-1',
    userId: 'user-1',
    stage: 'proto_building' as PipelineStage,
    scribeConversation: [],
    traceEnabled: true,
    metrics: {
      startedAt: new Date(),
      clarificationRounds: 0,
      retryCount: 0,
    },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockStore(pipeline?: PipelineState | null) {
  let stored = pipeline ?? null;
  return {
    getById: async (_id: string) => stored,
    update: async (_id: string, data: Partial<PipelineState>) => {
      if (stored) {
        stored = { ...stored, ...data } as PipelineState;
      }
      return stored as PipelineState;
    },
    create: async () => stored as PipelineState,
    listByUser: async () => (stored ? [stored] : []),
  };
}

// ================================================================
// stateHelpers
// ================================================================

describe('stateHelpers', () => {
  describe('isTerminalStage', () => {
    it('returns true for completed', () => {
      assert.equal(isTerminalStage('completed'), true);
    });

    it('returns true for failed', () => {
      assert.equal(isTerminalStage('failed'), true);
    });

    it('returns true for cancelled', () => {
      assert.equal(isTerminalStage('cancelled'), true);
    });

    it('returns true for completed_partial', () => {
      assert.equal(isTerminalStage('completed_partial'), true);
    });

    it('returns false for proto_building', () => {
      assert.equal(isTerminalStage('proto_building'), false);
    });

    it('returns false for scribe_clarifying', () => {
      assert.equal(isTerminalStage('scribe_clarifying'), false);
    });

    it('returns false for awaiting_approval', () => {
      assert.equal(isTerminalStage('awaiting_approval'), false);
    });

    it('returns false for trace_testing', () => {
      assert.equal(isTerminalStage('trace_testing'), false);
    });

    it('returns false for awaiting_push_confirm', () => {
      assert.equal(isTerminalStage('awaiting_push_confirm'), false);
    });
  });

  describe('deriveRepoName', () => {
    it('lowercases and slugifies a simple title', () => {
      assert.equal(deriveRepoName('My Cool App'), 'my-cool-app');
    });

    it('replaces Turkish characters', () => {
      // Turkish chars are non-a-z so they get replaced by the regex
      assert.equal(deriveRepoName('Calisma Ortami'), 'calisma-ortami');
    });

    it('strips leading and trailing hyphens', () => {
      assert.equal(deriveRepoName('--hello--'), 'hello');
    });

    it('collapses consecutive special chars into single hyphen', () => {
      assert.equal(deriveRepoName('a!!!b###c'), 'a-b-c');
    });

    it('truncates to 50 characters', () => {
      const long = 'a'.repeat(60);
      assert.equal(deriveRepoName(long).length, 50);
    });

    it('handles empty string', () => {
      assert.equal(deriveRepoName(''), '');
    });

    it('handles all-special-char input', () => {
      // All chars replaced -> stripped -> empty
      assert.equal(deriveRepoName('!!!'), '');
    });
  });

  describe('assertStage', () => {
    it('does not throw when stage matches', () => {
      const pipeline = makePipelineState({ stage: 'awaiting_approval' });
      assert.doesNotThrow(() => assertStage(pipeline, 'awaiting_approval'));
    });

    it('throws InvalidStageError when stage does not match', () => {
      const pipeline = makePipelineState({ stage: 'proto_building' });
      assert.throws(() => assertStage(pipeline, 'awaiting_approval'), {
        name: 'InvalidStageError',
        message: /expected awaiting_approval, got proto_building/,
      });
    });
  });

  describe('reconstructScribeState', () => {
    it('extracts idea from user_idea message', () => {
      const pipeline = makePipelineState({
        stage: 'scribe_clarifying',
        scribeConversation: [{ type: 'user_idea', content: 'Build a todo app' }],
      });
      const state = reconstructScribeState(pipeline);
      assert.equal(state.idea, 'Build a todo app');
    });

    it('counts clarification rounds', () => {
      const pipeline = makePipelineState({
        stage: 'scribe_clarifying',
        scribeConversation: [
          { type: 'user_idea', content: 'My idea' },
          { type: 'clarification', content: { questions: [] } },
          { type: 'user_answer', content: 'Answer 1' },
          { type: 'clarification', content: { questions: [] } },
        ],
      });
      const state = reconstructScribeState(pipeline);
      assert.equal(state.clarificationRound, 2);
    });

    it('sets phase to done when awaiting_approval', () => {
      const pipeline = makePipelineState({
        stage: 'awaiting_approval',
        scribeConversation: [{ type: 'user_idea', content: 'idea' }],
      });
      const state = reconstructScribeState(pipeline);
      assert.equal(state.phase, 'done');
    });

    it('sets phase to clarifying for non-approval stages', () => {
      const pipeline = makePipelineState({
        stage: 'scribe_clarifying',
        scribeConversation: [{ type: 'user_idea', content: 'idea' }],
      });
      const state = reconstructScribeState(pipeline);
      assert.equal(state.phase, 'clarifying');
    });

    it('returns empty idea when no user_idea message present', () => {
      const pipeline = makePipelineState({
        scribeConversation: [],
      });
      const state = reconstructScribeState(pipeline);
      assert.equal(state.idea, '');
    });
  });

  describe('getPipeline', () => {
    it('returns pipeline when found', async () => {
      const pipeline = makePipelineState({ id: 'found-1' });
      const store = makeMockStore(pipeline);
      const result = await getPipeline('found-1', store as any);
      assert.equal(result.id, 'found-1');
    });

    it('throws PipelineNotFoundError when not found', async () => {
      const store = makeMockStore(null);
      await assert.rejects(() => getPipeline('missing-1', store as any), {
        name: 'PipelineNotFoundError',
        message: /Pipeline not found: missing-1/,
      });
    });
  });

  describe('isCancelled', () => {
    it('returns true when pipeline stage is cancelled', async () => {
      const pipeline = makePipelineState({ stage: 'cancelled' });
      const store = makeMockStore(pipeline);
      const result = await isCancelled('pipe-1', store as any);
      assert.equal(result, true);
    });

    it('returns false when pipeline stage is not cancelled', async () => {
      const pipeline = makePipelineState({ stage: 'proto_building' });
      const store = makeMockStore(pipeline);
      const result = await isCancelled('pipe-1', store as any);
      assert.equal(result, false);
    });

    it('returns false when store throws', async () => {
      const store = {
        getById: async () => {
          throw new Error('DB down');
        },
      };
      const result = await isCancelled('pipe-1', store as any);
      assert.equal(result, false);
    });

    it('returns false when pipeline not found', async () => {
      const store = makeMockStore(null);
      const result = await isCancelled('pipe-1', store as any);
      assert.equal(result, false);
    });
  });

  describe('validateGitHubAccess', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      // Restore original env after each test
      process.env = { ...OLD_ENV };
    });

    it('returns mock token/owner in DOGFOOD_MODE', async () => {
      process.env.DOGFOOD_MODE = 'true';
      process.env.NODE_ENV = 'test'; // not production
      const result = await validateGitHubAccess(
        'user-1',
        async () => null,
        async () => 'real-owner'
      );
      assert.equal(result.token, 'ghp_mock_dogfood');
      assert.equal(result.owner, 'dogfood-owner');
    });

    it('throws when token is null', async () => {
      delete process.env.DOGFOOD_MODE;
      await assert.rejects(
        () =>
          validateGitHubAccess(
            'user-1',
            async () => null,
            async () => 'owner'
          ),
        { message: /GitHub bağlantısı bulunamadı/ }
      );
    });

    it('returns token and owner on success with mock token', async () => {
      delete process.env.DOGFOOD_MODE;
      const result = await validateGitHubAccess(
        'user-1',
        async () => 'ghp_mock_test123',
        async () => 'test-owner'
      );
      assert.equal(result.token, 'ghp_mock_test123');
      assert.equal(result.owner, 'test-owner');
    });
  });
});

// ================================================================
// metricsHelpers
// ================================================================

describe('metricsHelpers', () => {
  describe('createTokenCallback', () => {
    it('creates a callback that accumulates token usage', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      const cb = createTokenCallback('pipe-1', accumulators);

      cb({ inputTokens: 100, outputTokens: 50 });
      cb({ inputTokens: 200, outputTokens: 75, estimatedCostUsd: 0.005 });

      const acc = accumulators.get('pipe-1');
      assert.ok(acc);
      assert.equal(acc.inputTokens, 300);
      assert.equal(acc.outputTokens, 125);
      assert.equal(acc.estimatedCostUsd, 0.005);
      assert.equal(acc.hasCost, true);
    });

    it('initializes accumulator lazily on first call', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      const cb = createTokenCallback('pipe-2', accumulators);

      assert.equal(accumulators.has('pipe-2'), false);
      cb({ inputTokens: 10, outputTokens: 5 });
      assert.equal(accumulators.has('pipe-2'), true);
    });

    it('ignores non-finite estimatedCostUsd', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      const cb = createTokenCallback('pipe-1', accumulators);

      cb({ inputTokens: 10, outputTokens: 5, estimatedCostUsd: NaN });
      const acc = accumulators.get('pipe-1')!;
      assert.equal(acc.hasCost, false);
      assert.equal(acc.estimatedCostUsd, 0);
    });
  });

  describe('flushTokenUsage', () => {
    it('flushes accumulated tokens to store and clears accumulator', async () => {
      const accumulators = new Map<string, TokenAccumulator>();
      accumulators.set('pipe-1', {
        inputTokens: 500,
        outputTokens: 200,
        estimatedCostUsd: 0.01,
        hasCost: true,
      });

      const pipeline = makePipelineState({
        id: 'pipe-1',
        metrics: {
          startedAt: new Date(),
          clarificationRounds: 0,
          retryCount: 0,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCost: 0.002,
        },
      });
      const store = makeMockStore(pipeline);
      let updatedMetrics: any = null;
      store.update = async (_id: string, data: any) => {
        updatedMetrics = data.metrics;
        return pipeline;
      };

      await flushTokenUsage('pipe-1', accumulators, store as any);

      assert.ok(updatedMetrics);
      assert.equal(updatedMetrics.inputTokens, 600);
      assert.equal(updatedMetrics.outputTokens, 250);
      assert.equal(updatedMetrics.totalTokens, 850);
      assert.equal(accumulators.has('pipe-1'), false);
    });

    it('skips flush when accumulator is empty', async () => {
      const accumulators = new Map<string, TokenAccumulator>();
      accumulators.set('pipe-1', {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        hasCost: false,
      });

      let updateCalled = false;
      const store = {
        getById: async () => makePipelineState(),
        update: async () => {
          updateCalled = true;
          return makePipelineState();
        },
      };

      await flushTokenUsage('pipe-1', accumulators, store as any);
      assert.equal(updateCalled, false);
    });

    it('skips flush when no accumulator exists for pipeline', async () => {
      const accumulators = new Map<string, TokenAccumulator>();
      let updateCalled = false;
      const store = {
        getById: async () => makePipelineState(),
        update: async () => {
          updateCalled = true;
          return makePipelineState();
        },
      };

      await flushTokenUsage('pipe-nonexistent', accumulators, store as any);
      assert.equal(updateCalled, false);
    });
  });

  describe('getLiveTokenUsage', () => {
    it('combines persisted and in-memory tokens', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      accumulators.set('pipe-1', {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0,
        hasCost: false,
      });

      const result = getLiveTokenUsage('pipe-1', accumulators, {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      });

      assert.equal(result.inputTokens, 300);
      assert.equal(result.outputTokens, 150);
      assert.equal(result.totalTokens, 450);
    });

    it('returns only persisted when no accumulator', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      const result = getLiveTokenUsage('pipe-1', accumulators, {
        inputTokens: 200,
        outputTokens: 100,
      });
      assert.equal(result.inputTokens, 200);
      assert.equal(result.outputTokens, 100);
      assert.equal(result.totalTokens, 300);
    });

    it('returns only in-memory when no persisted metrics', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      accumulators.set('pipe-1', {
        inputTokens: 50,
        outputTokens: 25,
        estimatedCostUsd: 0,
        hasCost: false,
      });
      const result = getLiveTokenUsage('pipe-1', accumulators);
      assert.equal(result.inputTokens, 50);
      assert.equal(result.outputTokens, 25);
      assert.equal(result.totalTokens, 75);
    });

    it('returns zeros when nothing present', () => {
      const accumulators = new Map<string, TokenAccumulator>();
      const result = getLiveTokenUsage('pipe-unknown', accumulators);
      assert.equal(result.inputTokens, 0);
      assert.equal(result.outputTokens, 0);
      assert.equal(result.totalTokens, 0);
    });
  });

  describe('markStageStarted', () => {
    it('records timestamp for pipeline:stage key', () => {
      const starts = new Map<string, number>();
      const now = markStageStarted('pipe-1', 'proto', starts);
      assert.ok(starts.has('pipe-1:proto'));
      assert.equal(starts.get('pipe-1:proto'), now);
    });

    it('overwrites existing entry for same key', () => {
      const starts = new Map<string, number>();
      markStageStarted('pipe-1', 'proto', starts);
      const second = markStageStarted('pipe-1', 'proto', starts);
      assert.equal(starts.get('pipe-1:proto'), second);
    });
  });

  describe('getStageDurationMs', () => {
    it('returns duration and deletes entry', () => {
      const starts = new Map<string, number>();
      starts.set('pipe-1:trace', Date.now() - 5000);

      const duration = getStageDurationMs('pipe-1', 'trace', starts);
      assert.ok(duration !== undefined);
      assert.ok(duration >= 4900); // allow minor timing drift
      assert.equal(starts.has('pipe-1:trace'), false);
    });

    it('returns undefined when no entry exists', () => {
      const starts = new Map<string, number>();
      const duration = getStageDurationMs('pipe-1', 'trace', starts);
      assert.equal(duration, undefined);
    });

    it('is one-shot -- second call returns undefined', () => {
      const starts = new Map<string, number>();
      starts.set('pipe-1:scribe', Date.now() - 1000);

      const first = getStageDurationMs('pipe-1', 'scribe', starts);
      assert.ok(first !== undefined);

      const second = getStageDurationMs('pipe-1', 'scribe', starts);
      assert.equal(second, undefined);
    });
  });

  describe('clearStageStarts', () => {
    it('removes all entries for a given pipeline', () => {
      const starts = new Map<string, number>();
      starts.set('pipe-1:scribe', 100);
      starts.set('pipe-1:proto', 200);
      starts.set('pipe-1:trace', 300);
      starts.set('pipe-2:scribe', 400);

      clearStageStarts('pipe-1', starts);

      assert.equal(starts.has('pipe-1:scribe'), false);
      assert.equal(starts.has('pipe-1:proto'), false);
      assert.equal(starts.has('pipe-1:trace'), false);
      assert.equal(starts.has('pipe-2:scribe'), true);
    });

    it('does nothing when no entries match', () => {
      const starts = new Map<string, number>();
      starts.set('pipe-2:proto', 100);

      clearStageStarts('pipe-999', starts);
      assert.equal(starts.size, 1);
    });
  });
});

// ================================================================
// activityHelpers
// ================================================================

describe('activityHelpers', () => {
  describe('countPriorEvents', () => {
    it('counts matching event types', () => {
      const conv: any[] = [
        { type: 'proto_completed', content: {}, timestamp: '' },
        { type: 'trace_completed', content: {}, timestamp: '' },
        { type: 'proto_completed', content: {}, timestamp: '' },
      ];
      assert.equal(countPriorEvents(conv, 'proto_completed'), 2);
      assert.equal(countPriorEvents(conv, 'trace_completed'), 1);
    });

    it('returns 0 for empty conversation', () => {
      assert.equal(countPriorEvents([], 'proto_completed'), 0);
    });

    it('returns 0 when no matching type found', () => {
      const conv: any[] = [{ type: 'user_idea', content: 'hello' }];
      assert.equal(countPriorEvents(conv, 'scribe_completed'), 0);
    });
  });

  describe('buildSubStepsForStage', () => {
    it('builds scribe substeps from scribeOutput', () => {
      const pipeline = makePipelineState({
        scribeOutput: {
          spec: {
            title: 'Test',
            problemStatement: 'test',
            userStories: [
              { persona: 'user', action: 'click', benefit: 'speed' },
              { persona: 'admin', action: 'manage', benefit: 'control' },
            ],
            acceptanceCriteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
            technicalConstraints: {},
            outOfScope: [],
          },
          plan: {} as any,
          rawMarkdown: '',
          confidence: 0.9,
          clarificationsAsked: 0,
        },
      });

      const steps = buildSubStepsForStage(pipeline, 'scribe');
      assert.equal(steps.length, 2);
      assert.ok(steps[0].label.includes('2 user story'));
      assert.ok(steps[1].label.includes('1 kabul kriteri'));
      assert.equal(steps[0].status, 'done');
    });

    it('builds proto substeps from protoOutput', () => {
      const pipeline = makePipelineState({
        protoOutput: {
          ok: true,
          branch: 'feat/test',
          repo: 'owner/repo',
          repoUrl: 'https://github.com/owner/repo',
          files: [
            { filePath: 'index.ts', content: 'console.log("hi")', linesOfCode: 1 },
            { filePath: 'app.ts', content: 'export {}', linesOfCode: 1 },
          ],
          setupCommands: [],
          metadata: { filesCreated: 2, totalLinesOfCode: 2, stackUsed: 'node', committed: true },
        },
      });

      const steps = buildSubStepsForStage(pipeline, 'proto');
      // Should have at least the two core steps
      assert.ok(steps.length >= 2);
      assert.ok(steps.some((s) => s.label.includes('iskelet')));
      assert.ok(steps.some((s) => s.label.includes('2 dosya')));
    });

    it('builds trace substeps from traceOutput', () => {
      const pipeline = makePipelineState({
        traceOutput: {
          ok: true,
          testFiles: [],
          coverageMatrix: {},
          testSummary: {
            totalTests: 15,
            coveragePercentage: 87,
            coveredCriteria: ['AC-1'],
            uncoveredCriteria: [],
          },
        },
      });

      const steps = buildSubStepsForStage(pipeline, 'trace');
      assert.ok(steps.length >= 1);
      assert.ok(steps.some((s) => s.label.includes('15 test')));
      assert.ok(steps.some((s) => s.label.includes('%87')));
    });

    it('returns empty array when no output data exists', () => {
      const pipeline = makePipelineState();
      assert.deepEqual(buildSubStepsForStage(pipeline, 'scribe'), []);
      assert.deepEqual(buildSubStepsForStage(pipeline, 'proto'), []);
      assert.deepEqual(buildSubStepsForStage(pipeline, 'trace'), []);
    });

    it('includes critic findings in scribe substeps when present', () => {
      const pipeline = makePipelineState({
        scribeOutput: {
          spec: {
            title: 'T',
            problemStatement: 'p',
            userStories: [],
            acceptanceCriteria: [],
            technicalConstraints: {},
            outOfScope: [],
          },
          plan: {} as any,
          rawMarkdown: '',
          confidence: 0.9,
          clarificationsAsked: 0,
        },
        intermediateState: {
          criticSpecOutput: {
            findings: [
              { description: 'missing AC', severity: 'warning', suggestion: 'add AC' },
              { description: 'vague req', severity: 'critical', suggestion: 'clarify' },
            ],
          },
        },
      });

      const steps = buildSubStepsForStage(pipeline, 'scribe');
      assert.ok(steps.some((s) => s.label.includes('2 eksik nokta')));
      assert.ok(steps.some((s) => s.source === 'critic'));
    });

    it('includes validator result in proto substeps when present', () => {
      const pipeline = makePipelineState({
        protoOutput: {
          ok: true,
          branch: 'feat/test',
          repo: 'owner/repo',
          repoUrl: 'https://github.com/owner/repo',
          files: [{ filePath: 'index.ts', content: '', linesOfCode: 1 }],
          setupCommands: [],
          metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'node', committed: true },
        },
        intermediateState: {
          validationResult: {
            passed: true,
            summary: { errors: 0, warnings: 2 },
          },
        },
      });

      const steps = buildSubStepsForStage(pipeline, 'proto');
      assert.ok(steps.some((s) => s.label.includes('temiz')));
      assert.ok(steps.some((s) => s.source === 'validator'));
    });
  });

  describe('buildScribeCompletedEvent', () => {
    it('returns correct event shape', () => {
      const output = {
        spec: {
          title: 'Test',
          problemStatement: 'test',
          userStories: [{ persona: 'u', action: 'a', benefit: 'b' }],
          acceptanceCriteria: [
            { id: 'AC-1', given: 'g', when: 'w', then: 't' },
            { id: 'AC-2', given: 'g2', when: 'w2', then: 't2' },
          ],
          technicalConstraints: {},
          outOfScope: [],
        },
        plan: {} as any,
        rawMarkdown: '',
        confidence: 0.9,
        clarificationsAsked: 1,
        summary: 'Plan hazir.',
      };

      const event = buildScribeCompletedEvent('pipe-1', 1, output, 5000);
      assert.equal(event.type, 'scribe_completed');
      assert.equal(event.content.iteration, 1);
      assert.equal(event.content.summary, 'Plan hazir.');
      assert.equal(event.content.storyCount, 1);
      assert.equal(event.content.acCount, 2);
      assert.equal(event.content.durationMs, 5000);
      assert.ok(event.timestamp);
    });

    it('uses default summary when output has none', () => {
      const output = {
        spec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        plan: {} as any,
        rawMarkdown: '',
        confidence: 0.9,
        clarificationsAsked: 0,
      };

      const event = buildScribeCompletedEvent('pipe-1', 1, output, undefined);
      assert.equal(event.content.summary, 'Plan hazırlandı.');
      assert.equal(event.content.durationMs, undefined);
    });

    it('includes subSteps when provided', () => {
      const output = {
        spec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        plan: {} as any,
        rawMarkdown: '',
        confidence: 0.9,
        clarificationsAsked: 0,
      };

      const subSteps = [{ label: 'step 1', status: 'done' as const, source: 'agent' as const }];
      const event = buildScribeCompletedEvent('pipe-1', 2, output, 1000, subSteps);
      assert.deepEqual(event.content.subSteps, subSteps);
    });

    it('omits subSteps when empty array provided', () => {
      const output = {
        spec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        plan: {} as any,
        rawMarkdown: '',
        confidence: 0.9,
        clarificationsAsked: 0,
      };

      const event = buildScribeCompletedEvent('pipe-1', 1, output, undefined, []);
      assert.equal(event.content.subSteps, undefined);
    });
  });
});

// ================================================================
// criticHelpers
// ================================================================

describe('criticHelpers', () => {
  describe('evaluateTraceIterateLoop', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.TRACE_MAX_ITERATE_RETRIES;
    });

    it('returns shouldIterate=false when traceEnabled is false', async () => {
      const pipeline = makePipelineState({ traceEnabled: false });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: false,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 5,
          coveragePercentage: 50,
          coveredCriteria: ['AC-1'],
          uncoveredCriteria: ['AC-2', 'AC-3'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, false);
    });

    it('returns shouldIterate=false when all criteria covered and ok=true', async () => {
      const pipeline = makePipelineState({ traceEnabled: true });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 10,
          coveragePercentage: 100,
          coveredCriteria: ['AC-1', 'AC-2'],
          uncoveredCriteria: [],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, false);
    });

    it('returns shouldIterate=true when uncovered criteria exist and below max retries', async () => {
      const pipeline = makePipelineState({
        traceEnabled: true,
        intermediateState: { traceIterateRetryCount: 0 },
      });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 5,
          coveragePercentage: 60,
          coveredCriteria: ['AC-1'],
          uncoveredCriteria: ['AC-2', 'AC-3'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, true);
      assert.equal(result.nextRetry, 1);
      assert.equal(result.uncoveredCount, 2);
      assert.ok(result.feedback.length > 0);
    });

    it('returns shouldIterate=false when max retries reached', async () => {
      process.env.TRACE_MAX_ITERATE_RETRIES = '2';
      const pipeline = makePipelineState({
        traceEnabled: true,
        intermediateState: { traceIterateRetryCount: 2 },
      });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 5,
          coveragePercentage: 60,
          coveredCriteria: ['AC-1'],
          uncoveredCriteria: ['AC-2'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, false);
      assert.equal(result.uncoveredCount, 1);
    });

    it('returns shouldIterate=false when pipeline not found', async () => {
      const store = makeMockStore(null);
      const traceOutput = {
        ok: false,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 0,
          coveragePercentage: 0,
          coveredCriteria: [],
          uncoveredCriteria: ['AC-1'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, false);
    });

    it('includes failure info in feedback when ok=false', async () => {
      const pipeline = makePipelineState({
        traceEnabled: true,
        intermediateState: { traceIterateRetryCount: 0 },
      });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: false,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 3,
          coveragePercentage: 40,
          coveredCriteria: ['AC-1'],
          uncoveredCriteria: ['AC-2'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, true);
      assert.ok(result.feedback.includes('testler başarısız'));
    });

    it('respects env-configurable max retries', async () => {
      process.env.TRACE_MAX_ITERATE_RETRIES = '1';
      const pipeline = makePipelineState({
        traceEnabled: true,
        intermediateState: { traceIterateRetryCount: 1 },
      });
      const store = makeMockStore(pipeline);
      const traceOutput = {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 5,
          coveragePercentage: 50,
          coveredCriteria: [],
          uncoveredCriteria: ['AC-1'],
        },
      };

      const result = await evaluateTraceIterateLoop('pipe-1', traceOutput, store as any);
      assert.equal(result.shouldIterate, false);
      assert.equal(result.maxRetries, 1);
    });
  });

  describe('evaluateCriticIterateLoop', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      delete process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES;
    });

    it('returns shouldIterate=false when no critical findings', async () => {
      const pipeline = makePipelineState();
      const store = makeMockStore(pipeline);
      const criticResult = {
        findings: [
          { description: 'minor issue', severity: 'warning' as const, suggestion: 'fix it' },
        ],
      };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, false);
      assert.equal(result.criticalCount, 0);
    });

    it('returns shouldIterate=true with critical findings below max retries', async () => {
      const pipeline = makePipelineState({
        intermediateState: { criticIterateRetryCount: 0 },
      });
      const store = makeMockStore(pipeline);
      const criticResult = {
        findings: [
          {
            description: 'SQL injection risk',
            severity: 'critical' as const,
            suggestion: 'Use parameterized queries',
            location: 'db.ts:42',
          },
        ],
      };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, true);
      assert.equal(result.criticalCount, 1);
      assert.equal(result.nextRetry, 1);
      assert.ok(result.feedback.includes('SQL injection risk'));
      assert.ok(result.feedback.includes('db.ts:42'));
    });

    it('returns shouldIterate=false when max retries reached', async () => {
      process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '2';
      const pipeline = makePipelineState({
        intermediateState: { criticIterateRetryCount: 2 },
      });
      const store = makeMockStore(pipeline);
      const criticResult = {
        findings: [
          {
            description: 'critical issue',
            severity: 'critical' as const,
            suggestion: 'fix',
          },
        ],
      };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, false);
      assert.equal(result.criticalCount, 1);
    });

    it('returns shouldIterate=false when pipeline not found', async () => {
      const store = makeMockStore(null);
      const criticResult = {
        findings: [
          {
            description: 'critical',
            severity: 'critical' as const,
            suggestion: 'fix',
          },
        ],
      };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, false);
    });

    it('returns shouldIterate=false when findings array is empty', async () => {
      const pipeline = makePipelineState();
      const store = makeMockStore(pipeline);
      const criticResult = { findings: [] };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, false);
    });

    it('counts only critical findings, not warnings', async () => {
      const pipeline = makePipelineState({
        intermediateState: { criticIterateRetryCount: 0 },
      });
      const store = makeMockStore(pipeline);
      const criticResult = {
        findings: [
          { description: 'warn 1', severity: 'warning' as const, suggestion: 'w' },
          { description: 'crit 1', severity: 'critical' as const, suggestion: 'c' },
          { description: 'warn 2', severity: 'warning' as const, suggestion: 'w2' },
          { description: 'crit 2', severity: 'critical' as const, suggestion: 'c2' },
        ],
      };

      const result = await evaluateCriticIterateLoop('pipe-1', criticResult as any, store as any);
      assert.equal(result.shouldIterate, true);
      assert.equal(result.criticalCount, 2);
    });
  });
});
