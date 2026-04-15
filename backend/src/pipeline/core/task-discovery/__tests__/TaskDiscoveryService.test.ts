/**
 * TaskDiscoveryService — unit tests.
 *
 * Uses node:test runner (project standard).
 * Run: node --test --import tsx src/pipeline/core/task-discovery/__tests__/TaskDiscoveryService.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDiscoveryService } from '../TaskDiscoveryService.js';
import type { TaskDiscoveryInput } from '../TaskDiscoveryTypes.js';
import type { AIServiceLike } from '../../pipeline-factory.js';

// ─── Test Helpers ────────────────────────────────

function makeAIResponse(tasks: unknown[], suggestedPlan = 'Start with critical tasks.'): string {
  return JSON.stringify({ tasks, suggestedPlan });
}

function makeMockAIService(content: string): AIServiceLike {
  return {
    async generateWorkArtifact() {
      return { content };
    },
  };
}

function makeFailingAIService(error: Error): AIServiceLike {
  return {
    async generateWorkArtifact() {
      throw error;
    },
  };
}

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    title: 'Add unit tests',
    description: 'The project lacks unit tests for the main module.',
    category: 'test',
    priority: 'high',
    estimatedMinutes: 60,
    affectedFiles: ['src/main.ts'],
    complexity: 'moderate',
    rationale: 'Tests prevent regressions and improve confidence in code changes.',
    ...overrides,
  };
}

function makeInput(overrides: Partial<TaskDiscoveryInput> = {}): TaskDiscoveryInput {
  return {
    repoContext: {
      owner: 'test-owner',
      repo: 'test-repo',
      files: [
        { path: 'src/index.ts' },
        { path: 'package.json' },
        { path: 'README.md' },
      ],
      ...overrides.repoContext,
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────

describe('TaskDiscoveryService', () => {
  let service: TaskDiscoveryService;

  // ── 1. Discovers tasks from repo context ────────

  it('discovers tasks from repo context', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', title: 'Fix error handling' })];
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse(tasks)),
    });

    const result = await service.discoverTasks(makeInput());

    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, 'task-1');
    assert.equal(result.tasks[1].id, 'task-2');
    assert.ok(result.suggestedPlan.length > 0);
    assert.ok(result.analysisTime >= 0);
  });

  // ── 2. Respects maxTasks limit ──────────────────

  it('respects maxTasks limit', async () => {
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: `task-${i + 1}`, title: `Task ${i + 1}` }),
    );
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse(tasks)),
    });

    const result = await service.discoverTasks(makeInput({ maxTasks: 3 }));

    assert.equal(result.tasks.length, 3);
    assert.equal(result.tasks[0].id, 'task-1');
    assert.equal(result.tasks[2].id, 'task-3');
  });

  // ── 3. Handles empty repo context ───────────────

  it('handles empty repo context', async () => {
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse([])),
    });

    const result = await service.discoverTasks(
      makeInput({ repoContext: { owner: 'o', repo: 'r', files: [] } }),
    );

    assert.equal(result.tasks.length, 0);
    assert.ok(typeof result.repoHealth.codeQualityScore === 'number');
  });

  // ── 4. Calculates repo health correctly ─────────

  it('calculates repo health correctly', () => {
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse([])),
    });

    const healthFull = service.calculateRepoHealth([
      { path: 'src/__tests__/app.test.ts' },
      { path: '.github/workflows/ci.yml' },
      { path: 'README.md' },
      { path: '.eslintrc.json' },
      { path: 'src/index.ts' },
    ]);

    assert.equal(healthFull.hasTests, true);
    assert.equal(healthFull.hasCI, true);
    assert.equal(healthFull.hasDocs, true);
    assert.equal(healthFull.hasLinting, true);
    assert.equal(healthFull.codeQualityScore, 100);

    const healthEmpty = service.calculateRepoHealth([
      { path: 'src/index.ts' },
      { path: 'src/utils.ts' },
    ]);

    assert.equal(healthEmpty.hasTests, false);
    assert.equal(healthEmpty.hasCI, false);
    assert.equal(healthEmpty.hasDocs, false);
    assert.equal(healthEmpty.hasLinting, false);
    assert.equal(healthEmpty.codeQualityScore, 40);
  });

  // ── 5. Handles AI service error gracefully ──────

  it('handles AI service error gracefully', async () => {
    service = new TaskDiscoveryService({
      aiService: makeFailingAIService(new Error('API rate limit exceeded')),
    });

    const result = await service.discoverTasks(makeInput());

    assert.equal(result.tasks.length, 0);
    assert.ok(result.suggestedPlan.includes('error'));
    assert.ok(result.analysisTime >= 0);
    assert.ok(typeof result.repoHealth.codeQualityScore === 'number');
  });

  // ── 6. Parses AI JSON response correctly ────────

  it('parses AI JSON response correctly', async () => {
    const task = makeTask({
      category: 'security',
      priority: 'critical',
      complexity: 'complex',
      estimatedMinutes: 120,
      affectedFiles: ['src/auth.ts', 'src/middleware.ts'],
    });

    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse([task], 'Fix security issues first.')),
    });

    const result = await service.discoverTasks(makeInput());

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].category, 'security');
    assert.equal(result.tasks[0].priority, 'critical');
    assert.equal(result.tasks[0].complexity, 'complex');
    assert.equal(result.tasks[0].estimatedMinutes, 120);
    assert.deepEqual(result.tasks[0].affectedFiles, ['src/auth.ts', 'src/middleware.ts']);
    assert.equal(result.suggestedPlan, 'Fix security issues first.');
  });

  // ── 7. Defaults maxTasks to 10 ──────────────────

  it('defaults maxTasks to 10', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      makeTask({ id: `task-${i + 1}`, title: `Task ${i + 1}` }),
    );
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse(tasks)),
    });

    const result = await service.discoverTasks(makeInput());

    assert.equal(result.tasks.length, 10);
  });

  // ── 8. Includes userHint in AI prompt ───────────

  it('includes userHint in AI prompt when provided', async () => {
    let capturedTask = '';
    const mockAI: AIServiceLike = {
      async generateWorkArtifact(input) {
        capturedTask = input.task;
        return { content: makeAIResponse([]) };
      },
    };

    service = new TaskDiscoveryService({ aiService: mockAI });

    await service.discoverTasks(
      makeInput({ userHint: 'Focus on authentication security' }),
    );

    assert.ok(
      capturedTask.includes('Focus on authentication security'),
      'prompt should contain the userHint',
    );
  });

  // ── 9. Enforces hard max of 20 tasks ────────────

  it('enforces hard max of 20 tasks even when maxTasks exceeds it', async () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      makeTask({ id: `task-${i + 1}`, title: `Task ${i + 1}` }),
    );
    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse(tasks)),
    });

    const result = await service.discoverTasks(makeInput({ maxTasks: 50 }));

    assert.equal(result.tasks.length, 20);
  });

  // ── 10. Filters out invalid tasks ───────────────

  it('filters out tasks with invalid fields', async () => {
    const tasks = [
      makeTask({ id: 'valid-1' }),
      makeTask({ id: 'invalid-1', category: 'unknown' }), // invalid category
      makeTask({ id: 'valid-2', title: 'Another valid task' }),
      { id: 'invalid-2' }, // missing required fields
    ];

    service = new TaskDiscoveryService({
      aiService: makeMockAIService(makeAIResponse(tasks)),
    });

    const result = await service.discoverTasks(makeInput());

    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, 'valid-1');
    assert.equal(result.tasks[1].id, 'valid-2');
  });
});
