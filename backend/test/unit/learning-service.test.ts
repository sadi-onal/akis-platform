/**
 * LearningService — Unit Tests (node:test)
 * Tech 4: Persistent learning foundation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LearningService } from '../../src/pipeline/core/learning/LearningService.js';

describe('LearningService', () => {
  it('records and retrieves outcomes for a stage', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'proto', { success: true, duration: 5000, score: 95 });
    const outcomes = await svc.getAllOutcomes('proto');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].pipelineId, 'p1');
    assert.equal(outcomes[0].success, true);
  });

  it('returns empty array for unknown stage', async () => {
    const svc = new LearningService();
    const learnings = await svc.getRelevantLearnings('unknown', 'test context');
    assert.equal(learnings.length, 0);
  });

  it('computes stats correctly', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'proto', { success: true, duration: 3000 });
    await svc.recordOutcome('p2', 'proto', { success: false, duration: 7000, errorType: 'timeout' });
    await svc.recordOutcome('p3', 'proto', { success: true, duration: 5000 });

    const stats = await svc.getStats('proto');
    assert.equal(stats.totalOutcomes, 3);
    assert.ok(Math.abs(stats.successRate - 2 / 3) < 0.01);
    assert.equal(stats.avgDuration, 5000);
    assert.equal(stats.commonErrors.length, 1);
    assert.equal(stats.commonErrors[0].errorType, 'timeout');
  });

  it('returns relevant learnings sorted by keyword match', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'proto', { success: true, duration: 3000 }, 'react typescript spa');
    await svc.recordOutcome('p2', 'proto', { success: false, duration: 5000, errorType: 'build_fail' }, 'python django backend');
    await svc.recordOutcome('p3', 'proto', { success: true, duration: 4000 }, 'react native mobile app');

    const learnings = await svc.getRelevantLearnings('proto', 'react spa web app');
    assert.ok(learnings.length >= 2);
    // The react+spa outcome should score higher
    assert.equal(learnings[0].outcome.pipelineId, 'p1');
  });

  it('respects limit parameter', async () => {
    const svc = new LearningService();
    for (let i = 0; i < 10; i++) {
      await svc.recordOutcome(`p${i}`, 'trace', { success: true, duration: 1000 });
    }
    const learnings = await svc.getRelevantLearnings('trace', 'test', 3);
    assert.equal(learnings.length, 3);
  });

  it('evicts old entries when maxPerStage exceeded', async () => {
    const svc = new LearningService(5); // max 5 per stage
    for (let i = 0; i < 8; i++) {
      await svc.recordOutcome(`p${i}`, 'scribe', { success: true, duration: 1000 });
    }
    const outcomes = await svc.getAllOutcomes('scribe');
    assert.equal(outcomes.length, 5);
    // Should keep the last 5 (FIFO eviction)
    assert.equal(outcomes[0].pipelineId, 'p3');
  });

  it('builds prompt context string', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'proto', {
      success: false, duration: 8000, errorType: 'type_error', solution: 'Fix import paths',
    }, 'react component');

    const ctx = await svc.buildPromptContext('proto', 'react app');
    assert.ok(ctx.includes('Past Learnings'));
    assert.ok(ctx.includes('FAILED'));
    assert.ok(ctx.includes('type_error'));
    assert.ok(ctx.includes('Fix import paths'));
  });

  it('returns empty prompt context when no learnings', async () => {
    const svc = new LearningService();
    const ctx = await svc.buildPromptContext('proto', 'anything');
    assert.equal(ctx, '');
  });

  it('records error type and solution', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'trace', {
      success: false, duration: 2000, errorType: 'test_timeout', solution: 'Increase timeout',
    });
    const outcomes = await svc.getAllOutcomes('trace');
    assert.equal(outcomes[0].errorType, 'test_timeout');
    assert.equal(outcomes[0].solution, 'Increase timeout');
  });

  it('clear removes all data', async () => {
    const svc = new LearningService();
    await svc.recordOutcome('p1', 'proto', { success: true, duration: 1000 });
    await svc.recordOutcome('p2', 'trace', { success: true, duration: 2000 });
    svc.clear();
    const proto = await svc.getAllOutcomes('proto');
    const trace = await svc.getAllOutcomes('trace');
    assert.equal(proto.length, 0);
    assert.equal(trace.length, 0);
  });

  it('stats returns zeros for empty stage', async () => {
    const svc = new LearningService();
    const stats = await svc.getStats('empty');
    assert.equal(stats.totalOutcomes, 0);
    assert.equal(stats.successRate, 0);
    assert.equal(stats.avgDuration, 0);
  });
});
