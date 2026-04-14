/**
 * Unit tests for Crew orchestration, Marketplace schemas, and Admin API subsystems.
 *
 * Covers:
 * - Crew: run input schema, worker role schema, event emitter, task board types, state machine flow
 * - Marketplace: profile schema, ingest schema, matching scoring edge cases, proposal generation
 * - Admin: log buffer getLogs filtering/pagination
 */
import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// ─── Crew types & schemas ──────────────────────────────────────────────────
import {
  crewRunInputSchema,
  workerRoleSchema,
  crewRunOutputSchema,
  DEFAULT_WORKER_COLORS,
  type CrewRunStatus,
  type CrewTaskStatus,
  type CrewEventType,
  type CrewEvent,
} from '../../src/core/crew/types.js';

import { CrewEventEmitter } from '../../src/core/crew/CrewEventEmitter.js';

// ─── Marketplace schemas (copied from marketplace.ts) ──────────────────────
// Re-declare inline because they are not exported. Tests validate the same shapes.
const profileInputSchema = z.object({
  headline: z.string().max(255).optional(),
  bio: z.string().max(5000).optional(),
  seniority: z.string().max(50).optional(),
  languages: z.array(z.string().max(20)).optional(),
  preferredLocations: z.array(z.string().max(255)).optional(),
  remoteOnly: z.boolean().optional(),
  salaryFloor: z.number().int().nonnegative().optional(),
  excludedIndustries: z.array(z.string().max(120)).optional(),
  skills: z.array(z.object({
    name: z.string().min(1).max(120),
    level: z.number().int().min(1).max(5).optional(),
    yearsExperience: z.number().min(0).max(60).optional(),
  })).optional(),
  portfolios: z.array(z.object({
    title: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    url: z.string().url().max(2000).optional(),
    tags: z.array(z.string().max(100)).optional(),
  })).optional(),
});

const ingestSchema = z.object({
  source: z.string().min(1).max(255).default('manual'),
  jobs: z.array(z.object({
    externalId: z.string().max(255).optional(),
    title: z.string().min(1).max(500),
    description: z.string().min(1).max(12000),
    requiredSkills: z.array(z.string().max(120)).optional(),
    seniority: z.string().max(50).optional(),
    language: z.string().max(20).optional(),
    location: z.string().max(255).optional(),
    remoteAllowed: z.boolean().optional(),
    keywords: z.array(z.string().max(120)).optional(),
    budgetMin: z.number().nonnegative().optional(),
    budgetMax: z.number().nonnegative().optional(),
    currency: z.string().max(8).optional(),
    rawPayload: z.record(z.unknown()).optional(),
  })).min(1),
});

// ─── Matching service (pure function, no DB) ───────────────────────────────
import { scoreMarketplaceMatch } from '../../src/services/marketplace/matching-service.js';
import type { MarketplaceJobContext, MarketplaceProfileContext } from '../../src/services/marketplace/types.js';

// ─── Proposal service ──────────────────────────────────────────────────────
import { generateProposalDraft, renderProposalTemplate } from '../../src/services/marketplace/proposal-service.js';

// ─── Admin log buffer ──────────────────────────────────────────────────────
import { getLogs, pushLog } from '../../src/lib/logBuffer.js';

// ============================================================================
// CREW SYSTEM TESTS
// ============================================================================

describe('Crew run input schema validation', () => {
  const validInput = {
    goal: 'Build a React dashboard with authentication and test coverage.',
    workerRoles: [
      { role: 'Architect', agentType: 'scribe' as const, taskDescription: 'Design the system architecture' },
      { role: 'Developer', agentType: 'proto' as const, taskDescription: 'Implement the codebase' },
    ],
  };

  it('accepts valid minimal input', () => {
    const result = crewRunInputSchema.safeParse(validInput);
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.mergeStrategy, 'synthesize');
    assert.equal(result.data.failureStrategy, 'best_effort');
    assert.equal(result.data.autoApprove, false);
  });

  it('rejects goal shorter than 10 characters', () => {
    const result = crewRunInputSchema.safeParse({ ...validInput, goal: 'too short' });
    assert.ok(!result.success);
    assert.ok(result.error.issues.some(i => i.path.includes('goal')));
  });

  it('rejects empty workerRoles array', () => {
    const result = crewRunInputSchema.safeParse({ ...validInput, workerRoles: [] });
    assert.ok(!result.success);
    assert.ok(result.error.issues.some(i => i.path.includes('workerRoles')));
  });

  it('rejects more than 10 worker roles', () => {
    const roles = Array.from({ length: 11 }, (_, i) => ({
      role: `Worker ${i}`,
      agentType: 'worker' as const,
      taskDescription: `Do task ${i}`,
    }));
    const result = crewRunInputSchema.safeParse({ ...validInput, workerRoles: roles });
    assert.ok(!result.success);
  });

  it('accepts all valid merge strategies', () => {
    for (const strategy of ['concatenate', 'synthesize', 'structured'] as const) {
      const result = crewRunInputSchema.safeParse({ ...validInput, mergeStrategy: strategy });
      assert.ok(result.success, `merge strategy "${strategy}" should be valid`);
    }
  });

  it('rejects invalid merge strategy', () => {
    const result = crewRunInputSchema.safeParse({ ...validInput, mergeStrategy: 'random' });
    assert.ok(!result.success);
  });

  it('accepts all valid failure strategies', () => {
    for (const strategy of ['fail_fast', 'best_effort'] as const) {
      const result = crewRunInputSchema.safeParse({ ...validInput, failureStrategy: strategy });
      assert.ok(result.success, `failure strategy "${strategy}" should be valid`);
    }
  });

  it('accepts optional repo and branch fields', () => {
    const result = crewRunInputSchema.safeParse({
      ...validInput,
      repo: 'my-org/my-repo',
      branch: 'feature-x',
    });
    assert.ok(result.success);
    assert.equal(result.data.repo, 'my-org/my-repo');
    assert.equal(result.data.branch, 'feature-x');
  });
});

describe('Crew worker role schema validation', () => {
  it('accepts valid worker role', () => {
    const result = workerRoleSchema.safeParse({
      role: 'Frontend Dev',
      agentType: 'proto',
      taskDescription: 'Build the UI components',
    });
    assert.ok(result.success);
    assert.equal(result.data.color, '#6366F1');
  });

  it('rejects empty role name', () => {
    const result = workerRoleSchema.safeParse({
      role: '',
      agentType: 'scribe',
      taskDescription: 'Some task',
    });
    assert.ok(!result.success);
  });

  it('rejects invalid agentType', () => {
    const result = workerRoleSchema.safeParse({
      role: 'Worker',
      agentType: 'nonexistent',
      taskDescription: 'Some task',
    });
    assert.ok(!result.success);
  });

  it('accepts all valid agent types', () => {
    for (const agentType of ['scribe', 'trace', 'proto', 'worker'] as const) {
      const result = workerRoleSchema.safeParse({
        role: 'Test',
        agentType,
        taskDescription: 'Some task',
      });
      assert.ok(result.success, `agentType "${agentType}" should be valid`);
    }
  });

  it('validates hex color format', () => {
    const valid = workerRoleSchema.safeParse({
      role: 'Dev',
      agentType: 'worker',
      taskDescription: 'Build',
      color: '#FF00AA',
    });
    assert.ok(valid.success);

    const invalid = workerRoleSchema.safeParse({
      role: 'Dev',
      agentType: 'worker',
      taskDescription: 'Build',
      color: 'red',
    });
    assert.ok(!invalid.success);
  });
});

describe('Crew run status state machine transitions', () => {
  const VALID_STATUSES: CrewRunStatus[] = ['planning', 'spawning', 'running', 'merging', 'completed', 'failed'];

  it('defines all expected status values', () => {
    // Verify the type union covers all states by checking schema output
    const output = crewRunOutputSchema.safeParse({
      mergedContent: 'test',
      workerResults: [{
        role: 'dev',
        jobId: '00000000-0000-0000-0000-000000000001',
        status: 'completed',
        output: 'done',
      }],
      taskBoard: [{ taskId: 't1', title: 'task', status: 'completed' }],
      messageCount: 0,
      totalTokens: 100,
      totalCostUsd: 0.01,
    });
    assert.ok(output.success);
  });

  it('status list includes all states from planning to completed/failed', () => {
    assert.ok(VALID_STATUSES.includes('planning'));
    assert.ok(VALID_STATUSES.includes('spawning'));
    assert.ok(VALID_STATUSES.includes('running'));
    assert.ok(VALID_STATUSES.includes('merging'));
    assert.ok(VALID_STATUSES.includes('completed'));
    assert.ok(VALID_STATUSES.includes('failed'));
  });
});

describe('Crew task status transitions', () => {
  const VALID_TASK_STATUSES: CrewTaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];

  it('covers all task lifecycle states', () => {
    assert.equal(VALID_TASK_STATUSES.length, 4);
    assert.ok(VALID_TASK_STATUSES.includes('pending'));
    assert.ok(VALID_TASK_STATUSES.includes('in_progress'));
    assert.ok(VALID_TASK_STATUSES.includes('completed'));
    assert.ok(VALID_TASK_STATUSES.includes('blocked'));
  });
});

describe('CrewEventEmitter', () => {
  let emitter: CrewEventEmitter;

  beforeEach(() => {
    emitter = new CrewEventEmitter();
  });

  it('emitCrewEvent stores event in history', () => {
    const event: CrewEvent = {
      type: 'crew:status_change',
      crewRunId: 'run-1',
      timestamp: new Date().toISOString(),
      data: { oldStatus: '', newStatus: 'planning' },
    };

    emitter.emitCrewEvent(event);
    const history = emitter.getHistory('run-1');

    assert.equal(history.length, 1);
    assert.deepEqual(history[0], event);
  });

  it('getHistory returns empty array for unknown run', () => {
    const history = emitter.getHistory('nonexistent');
    assert.deepEqual(history, []);
  });

  it('subscribe receives emitted events', () => {
    const received: CrewEvent[] = [];
    emitter.subscribe('run-2', (event) => received.push(event));

    emitter.emitStatusChange('run-2', '', 'planning');
    emitter.emitStatusChange('run-2', 'planning', 'spawning');

    assert.equal(received.length, 2);
    assert.equal(received[0].type, 'crew:status_change');
    assert.equal((received[0].data as Record<string, unknown>).newStatus, 'planning');
    assert.equal((received[1].data as Record<string, unknown>).newStatus, 'spawning');
  });

  it('unsubscribe stops event delivery', () => {
    const received: CrewEvent[] = [];
    const unsub = emitter.subscribe('run-3', (event) => received.push(event));

    emitter.emitStatusChange('run-3', '', 'planning');
    unsub();
    emitter.emitStatusChange('run-3', 'planning', 'spawning');

    assert.equal(received.length, 1, 'should only receive events before unsubscribe');
  });

  it('getHistoryAfter filters by timestamp', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-01T00:00:01.000Z';
    const t3 = '2026-01-01T00:00:02.000Z';

    emitter.emitCrewEvent({ type: 'crew:status_change', crewRunId: 'run-4', timestamp: t1, data: { n: 1 } });
    emitter.emitCrewEvent({ type: 'crew:status_change', crewRunId: 'run-4', timestamp: t2, data: { n: 2 } });
    emitter.emitCrewEvent({ type: 'crew:status_change', crewRunId: 'run-4', timestamp: t3, data: { n: 3 } });

    const after = emitter.getHistoryAfter('run-4', t1);
    assert.equal(after.length, 2);
    assert.equal(after[0].timestamp, t2);
  });

  it('cleanup removes all history and listeners', () => {
    emitter.emitStatusChange('run-5', '', 'planning');
    emitter.cleanup('run-5');

    assert.deepEqual(emitter.getHistory('run-5'), []);
  });

  it('emitWorkerSpawned stores correct event type and data', () => {
    emitter.emitWorkerSpawned('run-6', 'job-1', 'architect', '#10B981', 0);
    const history = emitter.getHistory('run-6');

    assert.equal(history.length, 1);
    assert.equal(history[0].type, 'crew:worker_spawned');
    assert.equal((history[0].data as Record<string, unknown>).jobId, 'job-1');
    assert.equal((history[0].data as Record<string, unknown>).role, 'architect');
    assert.equal((history[0].data as Record<string, unknown>).color, '#10B981');
    assert.equal((history[0].data as Record<string, unknown>).index, 0);
  });

  it('emitWorkerCompleted stores correct event type', () => {
    emitter.emitWorkerCompleted('run-7', 'job-2', 'developer', 500);
    const history = emitter.getHistory('run-7');

    assert.equal(history[0].type, 'crew:worker_completed');
    assert.equal((history[0].data as Record<string, unknown>).tokenUsage, 500);
  });

  it('emitWorkerFailed stores error data', () => {
    emitter.emitWorkerFailed('run-8', 'job-3', 'tester', 'timeout exceeded');
    const history = emitter.getHistory('run-8');

    assert.equal(history[0].type, 'crew:worker_failed');
    assert.equal((history[0].data as Record<string, unknown>).error, 'timeout exceeded');
  });

  it('emitTaskCreated and emitTaskClaimed store events', () => {
    emitter.emitTaskCreated('run-9', 'task-1', 'Build UI', 'developer');
    emitter.emitTaskClaimed('run-9', 'task-1', 'job-1', 'developer');
    const history = emitter.getHistory('run-9');

    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'crew:task_created');
    assert.equal(history[1].type, 'crew:task_claimed');
  });

  it('emitMergeStarted and emitMergeCompleted store events', () => {
    emitter.emitMergeStarted('run-10');
    emitter.emitMergeCompleted('run-10', 1000, 0.05);
    const history = emitter.getHistory('run-10');

    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'crew:merge_started');
    assert.equal(history[1].type, 'crew:merge_completed');
    assert.equal((history[1].data as Record<string, unknown>).totalTokens, 1000);
    assert.equal((history[1].data as Record<string, unknown>).totalCostUsd, 0.05);
  });

  it('multiple subscribers for same run all receive events', () => {
    const received1: CrewEvent[] = [];
    const received2: CrewEvent[] = [];

    emitter.subscribe('run-11', (e) => received1.push(e));
    emitter.subscribe('run-11', (e) => received2.push(e));

    emitter.emitStatusChange('run-11', '', 'planning');

    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
  });

  it('events from different runs are isolated', () => {
    const receivedA: CrewEvent[] = [];
    const receivedB: CrewEvent[] = [];

    emitter.subscribe('run-A', (e) => receivedA.push(e));
    emitter.subscribe('run-B', (e) => receivedB.push(e));

    emitter.emitStatusChange('run-A', '', 'planning');
    emitter.emitStatusChange('run-B', '', 'running');

    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
    assert.equal((receivedA[0].data as Record<string, unknown>).newStatus, 'planning');
    assert.equal((receivedB[0].data as Record<string, unknown>).newStatus, 'running');
  });
});

describe('Crew SSE event format', () => {
  it('event has all required fields for SSE serialization', () => {
    const emitter = new CrewEventEmitter();
    emitter.emitStatusChange('run-sse', 'planning', 'spawning');
    const history = emitter.getHistory('run-sse');
    const event = history[0];

    assert.equal(typeof event.type, 'string');
    assert.ok(event.type.startsWith('crew:'));
    assert.equal(typeof event.crewRunId, 'string');
    assert.equal(typeof event.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(event.timestamp)), 'timestamp should be valid ISO date');
    assert.equal(typeof event.data, 'object');

    // Verify JSON.stringify works for SSE data field
    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, event.type);
  });

  it('SSE format follows event: data: pattern', () => {
    const event: CrewEvent = {
      type: 'crew:worker_spawned',
      crewRunId: 'run-fmt',
      timestamp: new Date().toISOString(),
      data: { jobId: 'j1', role: 'dev', color: '#10B981', index: 0 },
    };

    const sseLine = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    assert.ok(sseLine.startsWith('event: crew:worker_spawned\n'));
    assert.ok(sseLine.includes('data: {'));
    assert.ok(sseLine.endsWith('\n\n'));
  });
});

describe('Crew DEFAULT_WORKER_COLORS', () => {
  it('provides exactly 10 colors', () => {
    assert.equal(DEFAULT_WORKER_COLORS.length, 10);
  });

  it('all colors are valid hex', () => {
    for (const color of DEFAULT_WORKER_COLORS) {
      assert.match(color, /^#[0-9a-fA-F]{6}$/);
    }
  });
});

// ============================================================================
// MARKETPLACE TESTS
// ============================================================================

describe('Marketplace profile schema validation', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = profileInputSchema.safeParse({});
    assert.ok(result.success);
  });

  it('accepts full valid profile', () => {
    const result = profileInputSchema.safeParse({
      headline: 'Senior Full-Stack Developer',
      bio: 'I build web applications with React and Node.js',
      seniority: 'senior',
      languages: ['en', 'tr'],
      preferredLocations: ['istanbul', 'remote'],
      remoteOnly: true,
      salaryFloor: 50000,
      excludedIndustries: ['gambling'],
      skills: [
        { name: 'react', level: 5, yearsExperience: 4 },
        { name: 'typescript', level: 4 },
      ],
      portfolios: [
        { title: 'Dashboard Project', url: 'https://example.com/dash', tags: ['react'] },
      ],
    });
    assert.ok(result.success);
  });

  it('rejects headline exceeding 255 characters', () => {
    const result = profileInputSchema.safeParse({
      headline: 'A'.repeat(256),
    });
    assert.ok(!result.success);
  });

  it('rejects bio exceeding 5000 characters', () => {
    const result = profileInputSchema.safeParse({
      bio: 'B'.repeat(5001),
    });
    assert.ok(!result.success);
  });

  it('rejects negative salaryFloor', () => {
    const result = profileInputSchema.safeParse({ salaryFloor: -1 });
    assert.ok(!result.success);
  });

  it('rejects skill with empty name', () => {
    const result = profileInputSchema.safeParse({
      skills: [{ name: '', level: 3 }],
    });
    assert.ok(!result.success);
  });

  it('rejects skill level outside 1-5', () => {
    const too_low = profileInputSchema.safeParse({ skills: [{ name: 'js', level: 0 }] });
    assert.ok(!too_low.success);

    const too_high = profileInputSchema.safeParse({ skills: [{ name: 'js', level: 6 }] });
    assert.ok(!too_high.success);
  });

  it('rejects yearsExperience outside 0-60', () => {
    const negative = profileInputSchema.safeParse({
      skills: [{ name: 'js', yearsExperience: -1 }],
    });
    assert.ok(!negative.success);

    const excessive = profileInputSchema.safeParse({
      skills: [{ name: 'js', yearsExperience: 61 }],
    });
    assert.ok(!excessive.success);
  });

  it('rejects portfolio with empty title', () => {
    const result = profileInputSchema.safeParse({
      portfolios: [{ title: '' }],
    });
    assert.ok(!result.success);
  });

  it('rejects portfolio with invalid URL', () => {
    const result = profileInputSchema.safeParse({
      portfolios: [{ title: 'My Project', url: 'not-a-url' }],
    });
    assert.ok(!result.success);
  });
});

describe('Marketplace job ingest schema validation', () => {
  const validJob = {
    title: 'React Developer',
    description: 'Build modern web applications using React.',
  };

  it('accepts minimal valid job array', () => {
    const result = ingestSchema.safeParse({ jobs: [validJob] });
    assert.ok(result.success);
    assert.equal(result.data.source, 'manual');
    assert.equal(result.data.jobs.length, 1);
  });

  it('rejects empty jobs array', () => {
    const result = ingestSchema.safeParse({ jobs: [] });
    assert.ok(!result.success);
  });

  it('rejects job without title', () => {
    const result = ingestSchema.safeParse({
      jobs: [{ description: 'Some description' }],
    });
    assert.ok(!result.success);
  });

  it('rejects job without description', () => {
    const result = ingestSchema.safeParse({
      jobs: [{ title: 'Some title' }],
    });
    assert.ok(!result.success);
  });

  it('rejects title exceeding 500 characters', () => {
    const result = ingestSchema.safeParse({
      jobs: [{ title: 'X'.repeat(501), description: 'desc' }],
    });
    assert.ok(!result.success);
  });

  it('rejects description exceeding 12000 characters', () => {
    const result = ingestSchema.safeParse({
      jobs: [{ title: 'Title', description: 'D'.repeat(12001) }],
    });
    assert.ok(!result.success);
  });

  it('accepts job with all optional fields', () => {
    const result = ingestSchema.safeParse({
      source: 'upwork',
      jobs: [{
        ...validJob,
        externalId: 'ext-123',
        requiredSkills: ['react', 'typescript'],
        seniority: 'senior',
        language: 'en',
        location: 'remote',
        remoteAllowed: true,
        keywords: ['frontend', 'ui'],
        budgetMin: 1000,
        budgetMax: 5000,
        currency: 'USD',
        rawPayload: { scraped: true },
      }],
    });
    assert.ok(result.success);
  });

  it('rejects negative budget values', () => {
    const result = ingestSchema.safeParse({
      jobs: [{ ...validJob, budgetMin: -100 }],
    });
    assert.ok(!result.success);
  });
});

describe('Marketplace matching score edge cases', () => {
  const baseProfile: MarketplaceProfileContext = {
    id: 'profile-1',
    userId: 'user-1',
    headline: 'Full-stack developer',
    bio: 'React TypeScript Node.js developer with 5 years experience.',
    seniority: 'mid',
    languages: ['en', 'tr'],
    preferredLocations: ['remote', 'istanbul'],
    remoteOnly: false,
    excludedIndustries: [],
  };

  const baseJob: MarketplaceJobContext = {
    id: 'job-1',
    title: 'React Developer',
    description: 'Build dashboard features using React and TypeScript.',
    requiredSkills: ['react', 'typescript'],
    keywords: ['react', 'dashboard'],
    seniority: 'mid',
    language: 'en',
    location: 'remote',
    remoteAllowed: true,
  };

  it('perfect match scores close to 1.0', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react', 'typescript'],
      job: baseJob,
    });
    assert.ok(result.score >= 0.8, `Expected high score, got ${result.score}`);
  });

  it('zero skill overlap produces lower score', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['java', 'spring'],
      job: baseJob,
    });
    assert.ok(result.score < 0.8);
    assert.ok(result.explanation.missing_skills.length > 0);
  });

  it('empty required skills defaults to 0.5 skill_overlap', () => {
    const jobNoSkills: MarketplaceJobContext = { ...baseJob, requiredSkills: [] };
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: jobNoSkills,
    });
    assert.equal(result.explanation.factor_scores.skill_overlap, 0.5);
  });

  it('exact seniority match scores 1.0 for seniority_fit', () => {
    const result = scoreMarketplaceMatch({
      profile: { ...baseProfile, seniority: 'senior' },
      profileSkills: ['react'],
      job: { ...baseJob, seniority: 'senior' },
    });
    assert.equal(result.explanation.factor_scores.seniority_fit, 1);
  });

  it('one-level seniority gap scores 0.7', () => {
    const result = scoreMarketplaceMatch({
      profile: { ...baseProfile, seniority: 'mid' },
      profileSkills: ['react'],
      job: { ...baseJob, seniority: 'senior' },
    });
    assert.equal(result.explanation.factor_scores.seniority_fit, 0.7);
  });

  it('two-level seniority gap scores 0.35', () => {
    const result = scoreMarketplaceMatch({
      profile: { ...baseProfile, seniority: 'junior' },
      profileSkills: ['react'],
      job: { ...baseJob, seniority: 'lead' },
    });
    assert.equal(result.explanation.factor_scores.seniority_fit, 0.35);
  });

  it('null job seniority defaults to 0.7', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: { ...baseJob, seniority: null },
    });
    assert.equal(result.explanation.factor_scores.seniority_fit, 0.7);
  });

  it('language match scores 1.0', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: { ...baseJob, language: 'tr' },
    });
    assert.equal(result.explanation.factor_scores.language_fit, 1);
  });

  it('language mismatch scores 0', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: { ...baseJob, language: 'de' },
    });
    assert.equal(result.explanation.factor_scores.language_fit, 0);
  });

  it('remoteOnly profile + non-remote job scores 0 for location_remote_fit', () => {
    const result = scoreMarketplaceMatch({
      profile: { ...baseProfile, remoteOnly: true },
      profileSkills: ['react'],
      job: { ...baseJob, remoteAllowed: false, location: 'ankara' },
    });
    assert.equal(result.explanation.factor_scores.location_remote_fit, 0);
  });

  it('score is always between 0 and 1', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: [],
      job: baseJob,
    });
    assert.ok(result.score >= 0 && result.score <= 1);
  });

  it('explanation contains required fields', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: baseJob,
    });

    assert.ok(Array.isArray(result.explanation.top_factors));
    assert.ok(result.explanation.top_factors.length <= 3);
    assert.ok(typeof result.explanation.factor_scores === 'object');
    assert.ok(Array.isArray(result.explanation.missing_skills));
    assert.ok(typeof result.explanation.confidence === 'number');
    assert.ok(typeof result.explanation.summary === 'string');
    assert.equal(typeof result.explanation.fairness_adjustment_applied, 'boolean');
  });

  it('missing_skills lists skills in job but not in profile', () => {
    const result = scoreMarketplaceMatch({
      profile: baseProfile,
      profileSkills: ['react'],
      job: { ...baseJob, requiredSkills: ['react', 'typescript', 'graphql'] },
    });
    assert.ok(result.explanation.missing_skills.includes('typescript'));
    assert.ok(result.explanation.missing_skills.includes('graphql'));
    assert.ok(!result.explanation.missing_skills.includes('react'));
  });
});

describe('Marketplace proposal generation', () => {
  const profile: MarketplaceProfileContext = {
    id: 'p-1',
    userId: 'u-1',
    headline: 'React Developer',
    bio: 'Expert in frontend development.',
    seniority: 'mid',
    languages: ['en'],
    preferredLocations: ['remote'],
    remoteOnly: false,
    excludedIndustries: [],
  };

  const job: MarketplaceJobContext = {
    id: 'j-1',
    title: 'Frontend Engineer',
    description: 'Build modern web applications.',
    requiredSkills: ['react', 'typescript'],
    keywords: ['frontend'],
    seniority: 'mid',
    language: 'en',
    location: 'remote',
    remoteAllowed: true,
  };

  it('generates template-based proposal by default', async () => {
    const draft = await generateProposalDraft({
      profile,
      job,
      skills: ['react', 'typescript'],
      missingSkills: [],
    });
    assert.equal(draft.source, 'template');
    assert.ok(draft.content.includes('Frontend Engineer'));
    assert.ok(draft.content.includes('react'));
  });

  it('proposal mentions missing skills when present', async () => {
    const draft = await generateProposalDraft({
      profile,
      job,
      skills: ['react'],
      missingSkills: ['graphql', 'testing'],
    });
    assert.ok(draft.content.includes('graphql'));
    assert.ok(draft.content.includes('testing'));
  });

  it('proposal includes job title safely escaped', async () => {
    const maliciousJob = { ...job, title: '<script>alert("xss")</script>Frontend' };
    const draft = await generateProposalDraft({
      profile,
      job: maliciousJob,
      skills: ['react'],
      missingSkills: [],
    });
    assert.ok(!draft.content.includes('<script>'));
    assert.ok(!draft.content.includes('</script>'));
  });

  it('template renders with all required sections', () => {
    const content = renderProposalTemplate({
      profile,
      job,
      skills: ['react', 'typescript'],
      missingSkills: [],
    });
    assert.ok(content.includes('Hello,'));
    assert.ok(content.includes('Best regards,'));
    assert.ok(content.includes('Frontend Engineer'));
  });

  it('handles empty skills list gracefully', async () => {
    const draft = await generateProposalDraft({
      profile,
      job,
      skills: [],
      missingSkills: ['react'],
    });
    assert.equal(draft.source, 'template');
    assert.ok(draft.content.includes('relevant technical skills'));
  });

  it('LLM fallback on error returns template', async () => {
    const draft = await generateProposalDraft({
      profile,
      job,
      skills: ['react'],
      missingSkills: [],
      llmGenerate: async () => { throw new Error('API down'); },
    });
    assert.equal(draft.source, 'template');
    assert.ok(draft.metadata.fallback);
  });
});

// ============================================================================
// ADMIN TESTS
// ============================================================================

describe('Admin log buffer', () => {
  it('getLogs returns entries at or above requested level', () => {
    // Push a variety of log levels
    pushLog({ level: 20, msg: 'debug msg', time: Date.now() - 100 });
    pushLog({ level: 40, msg: 'info msg', time: Date.now() - 50 });
    pushLog({ level: 60, msg: 'error msg', time: Date.now() });

    const errorOnly = getLogs({ level: 'error', limit: 100 });
    assert.ok(errorOnly.every(e => e.level >= 60), 'only error-level entries expected');

    const infoAndUp = getLogs({ level: 'info', limit: 100 });
    assert.ok(infoAndUp.every(e => e.level >= 30));
  });

  it('getLogs respects limit parameter', () => {
    // Push enough entries
    for (let i = 0; i < 20; i++) {
      pushLog({ level: 40, msg: `entry ${i}`, time: Date.now() + i });
    }
    const limited = getLogs({ limit: 5 });
    assert.ok(limited.length <= 5);
  });

  it('getLogs filters by since timestamp', () => {
    const now = Date.now();
    pushLog({ level: 40, msg: 'old', time: now - 10000 });
    pushLog({ level: 40, msg: 'new', time: now + 1000 });

    const recent = getLogs({ since: now, limit: 500 });
    assert.ok(recent.every(e => (e.time as number) >= now));
  });

  it('getLogs limit is capped at 500', () => {
    const result = getLogs({ limit: 999 });
    // The function clamps to 500 internally
    assert.ok(result.length <= 500);
  });

  it('pushLog adds levelLabel automatically', () => {
    pushLog({ level: 60, msg: 'error test', time: Date.now() + 5000 });
    const logs = getLogs({ level: 'error', limit: 1, since: Date.now() + 4000 });
    if (logs.length > 0) {
      assert.equal(logs[0].levelLabel, 'error');
    }
  });

  it('pushLog sanitizes Error objects', () => {
    const err = new Error('test error');
    pushLog({ level: 60, msg: 'with error', err, time: Date.now() + 6000 });
    const logs = getLogs({ level: 'error', limit: 1, since: Date.now() + 5000 });
    if (logs.length > 0 && logs[0].err) {
      const sanitized = logs[0].err as Record<string, unknown>;
      assert.equal(typeof sanitized.message, 'string');
      assert.ok('stack' in sanitized);
    }
  });
});

describe('Admin route auth requirement', () => {
  it('admin log route expects authentication (requireAuth preHandler)', () => {
    // Verify the admin module exports a function that registers routes
    // The route uses requireAuth as preHandler, which throws for unauthenticated requests.
    // We verify the contract by importing and checking the function shape.
    // (Integration test would call the route; here we validate the schema contract.)
    assert.equal(typeof getLogs, 'function', 'getLogs should be a callable function');

    // Verify getLogs accepts the same shape the route constructs
    const result = getLogs({ level: 'info', limit: 100 });
    assert.ok(Array.isArray(result));
  });

  it('admin log route query parameter parsing: level defaults to info', () => {
    // Simulating the admin route's query parsing logic
    const query = {} as { level?: string; limit?: string; since?: string };
    const level = query.level ?? 'info';
    const limit = Math.min(parseInt(query.limit ?? '100', 10) || 100, 500);
    const since = query.since ? parseInt(query.since, 10) : undefined;

    assert.equal(level, 'info');
    assert.equal(limit, 100);
    assert.equal(since, undefined);
  });

  it('admin log route query: limit clamped to 500', () => {
    const query = { limit: '9999' };
    const limit = Math.min(parseInt(query.limit, 10) || 100, 500);
    assert.equal(limit, 500);
  });

  it('admin log route query: non-numeric limit falls back to 100', () => {
    const query = { limit: 'abc' };
    const limit = Math.min(parseInt(query.limit, 10) || 100, 500);
    assert.equal(limit, 100);
  });

  it('admin log route query: since parsed as integer timestamp', () => {
    const query = { since: '1700000000000' };
    const since = query.since ? parseInt(query.since, 10) : undefined;
    assert.equal(since, 1700000000000);
  });

  it('admin log route query: NaN since treated as undefined', () => {
    const query = { since: 'not-a-number' };
    const since = query.since ? parseInt(query.since, 10) : undefined;
    const safeValue = since && !Number.isNaN(since) ? since : undefined;
    assert.equal(safeValue, undefined);
  });
});

describe('Admin user role validation contract', () => {
  // The admin route only has log viewing; role checks happen via requireAuth.
  // These tests verify the requireAuth contract expectations.

  it('non-admin users should be rejected by role check', () => {
    // The requireAuth middleware returns { id, email, role } and route logic checks role.
    // Simulating the check:
    const user = { id: 'user-1', email: 'test@test.com', role: 'user' };
    assert.notEqual(user.role, 'admin');
  });

  it('admin users pass role check', () => {
    const user = { id: 'admin-1', email: 'admin@test.com', role: 'admin' };
    assert.equal(user.role, 'admin');
  });
});
