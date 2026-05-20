// T4: unit tests for the iteration trajectory factory. Pure function — no
// DB, no orchestrator. The full orchestrator path (criticIterateRetryCount
// + intermediateState.iterationHistory) is covered by the existing
// orchestrator integration tests, which now exercise the new state field.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIterationTrajectory } from '../../src/pipeline/core/explainability/reasoningFactory.js';
import type { IterationHistoryEntry } from '../../src/pipeline/core/explainability/ExplainabilityTypes.js';

const baseEntry = (overrides: Partial<IterationHistoryEntry> = {}): IterationHistoryEntry => ({
  iteration: 1,
  protoConfidence: 0.62,
  criticScore: 52,
  criticFindingsCount: 8,
  criticCriticalCount: 3,
  timestamp: '2026-05-20T12:00:00.000Z',
  decision: 'rejected',
  ...overrides,
});

describe('buildIterationTrajectory', () => {
  it('returns undefined for empty or missing history', () => {
    assert.equal(buildIterationTrajectory(undefined), undefined);
    assert.equal(buildIterationTrajectory(null), undefined);
    assert.equal(buildIterationTrajectory([]), undefined);
  });

  it('returns a single-entry trajectory with null delta when the loop ran once', () => {
    const traj = buildIterationTrajectory([
      baseEntry({ iteration: 1, criticScore: 84, decision: 'approved' }),
    ]);
    assert.ok(traj);
    assert.equal(traj.entries.length, 1);
    assert.equal(traj.entries[0]!.iteration, 1);
    assert.equal(traj.criticScoreDelta, 0);
    assert.equal(traj.finalDecision, 'approved');
  });

  it('computes positive delta and final decision for a multi-iter success', () => {
    const traj = buildIterationTrajectory([
      baseEntry({ iteration: 1, criticScore: 52, decision: 'rejected' }),
      baseEntry({ iteration: 2, criticScore: 67, decision: 'rejected' }),
      baseEntry({ iteration: 3, criticScore: 84, decision: 'approved' }),
    ]);
    assert.ok(traj);
    assert.equal(traj.entries.length, 3);
    assert.equal(traj.criticScoreDelta, 84 - 52);
    assert.equal(traj.finalDecision, 'approved');
  });

  it('marks the final entry as blocked when max retries are exhausted', () => {
    const traj = buildIterationTrajectory([
      baseEntry({ iteration: 1, criticScore: 50, decision: 'rejected' }),
      baseEntry({ iteration: 2, criticScore: 48, decision: 'rejected' }),
      baseEntry({ iteration: 3, criticScore: 46, decision: 'blocked' }),
    ]);
    assert.ok(traj);
    assert.equal(traj.finalDecision, 'blocked');
    assert.equal(traj.criticScoreDelta, -4);
  });

  it('sorts entries by iteration number regardless of input order', () => {
    const traj = buildIterationTrajectory([
      baseEntry({ iteration: 3, criticScore: 84, decision: 'approved' }),
      baseEntry({ iteration: 1, criticScore: 52, decision: 'rejected' }),
      baseEntry({ iteration: 2, criticScore: 67, decision: 'rejected' }),
    ]);
    assert.ok(traj);
    assert.deepEqual(
      traj.entries.map((e) => e.iteration),
      [1, 2, 3]
    );
  });

  it('returns null delta when either end of the score window is missing', () => {
    const traj = buildIterationTrajectory([
      baseEntry({ iteration: 1, criticScore: null, decision: 'rejected' }),
      baseEntry({ iteration: 2, criticScore: 70, decision: 'approved' }),
    ]);
    assert.ok(traj);
    assert.equal(traj.criticScoreDelta, null);
  });
});
