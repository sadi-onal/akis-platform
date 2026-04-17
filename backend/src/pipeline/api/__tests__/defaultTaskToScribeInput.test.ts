/**
 * Default task→ScribeInput mapper used by the engineer plugin.
 * Kept as a pure function so we can exercise it without Fastify.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTaskToScribeInput } from '../engineer.plugin.js';
import type { EngineerSession, SelectedTask } from '../../core/session/SessionTypes.js';

function makeSession(overrides?: Partial<EngineerSession>): EngineerSession {
  return {
    id: 'sess-1',
    userId: 'user-1',
    owner: 'acme',
    repo: 'webapp',
    selectedTasks: [],
    currentTaskIndex: 0,
    timeBudgetMinutes: 60,
    elapsedMinutes: 0,
    totalPausedMinutes: 0,
    status: 'created',
    completedTasks: [],
    costs: { estimated: 0, actual: 0 },
    config: {
      maxTasks: 5,
      minTimeMinutes: 30,
      maxTimeMinutes: 180,
      costPerMinute: 0.0167,
      warningAtMinutes: 5,
    },
    ...overrides,
  };
}

function makeTask(overrides?: Partial<SelectedTask>): SelectedTask {
  return {
    taskId: 't1',
    title: 'Fix the login form',
    category: 'bug',
    estimatedMinutes: 15,
    status: 'queued',
    ...overrides,
  };
}

describe('defaultTaskToScribeInput', () => {
  it('uses title as the Scribe idea when no description is supplied', () => {
    const task = makeTask({ description: undefined });
    const input = defaultTaskToScribeInput(task, makeSession());
    assert.equal(input.idea, 'Fix the login form');
  });

  it('appends description under the title when available', () => {
    const task = makeTask({
      title: 'Fix the login form',
      description: 'Empty password silently accepted; must show error.',
    });
    const input = defaultTaskToScribeInput(task, makeSession());
    assert.equal(
      input.idea,
      'Fix the login form\n\nEmpty password silently accepted; must show error.',
    );
  });

  it('ignores a whitespace-only description (treated as no description)', () => {
    const task = makeTask({ description: '   \n\t' });
    const input = defaultTaskToScribeInput(task, makeSession());
    assert.equal(input.idea, 'Fix the login form');
  });

  it('threads category into context and repo owner/repo from the session', () => {
    const task = makeTask({ category: 'security' });
    const input = defaultTaskToScribeInput(task, makeSession({ owner: 'acme-sec', repo: 'core' }));
    assert.equal(input.context, 'Category: security');
    assert.deepEqual(input.existingRepo, { owner: 'acme-sec', repo: 'core', branch: 'main' });
  });
});
