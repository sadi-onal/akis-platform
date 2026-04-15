import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineMetricsService } from '../PipelineMetricsService.js';

describe('PipelineMetricsService', () => {
  let service: PipelineMetricsService;

  beforeEach(() => {
    service = new PipelineMetricsService();
  });

  it('should record correct duration for a started and ended stage', async () => {
    service.startStage('pipe-1', 'scribe');

    // Small delay so duration > 0
    await new Promise((resolve) => setTimeout(resolve, 10));

    service.endStage('pipe-1', 'scribe', true, { confidenceScore: 0.9 });

    const run = service.getRunMetrics('pipe-1');
    assert.ok(run, 'run metrics should exist');
    assert.equal(run.stages.length, 1);

    const stage = run.stages[0];
    assert.equal(stage.stageName, 'scribe');
    assert.equal(stage.success, true);
    assert.ok(stage.durationMs >= 0, 'duration should be non-negative');
    assert.equal(stage.metadata.confidenceScore, 0.9);
  });

  it('should record multiple stages in sequence', async () => {
    service.startStage('pipe-2', 'scribe');
    service.endStage('pipe-2', 'scribe', true, { confidenceScore: 0.85 });

    service.startStage('pipe-2', 'proto');
    service.endStage('pipe-2', 'proto', true, { filesGenerated: 5 });

    service.startStage('pipe-2', 'trace');
    service.endStage('pipe-2', 'trace', true, { testsGenerated: 3 });

    const run = service.getRunMetrics('pipe-2');
    assert.ok(run);
    assert.equal(run.stages.length, 3);
    assert.equal(run.stages[0].stageName, 'scribe');
    assert.equal(run.stages[1].stageName, 'proto');
    assert.equal(run.stages[2].stageName, 'trace');
    assert.equal(run.finalStatus, 'completed');
  });

  it('should return run metrics with correct pipeline id and status', () => {
    service.startStage('pipe-3', 'scribe');
    service.endStage('pipe-3', 'scribe', false, {});

    const run = service.getRunMetrics('pipe-3');
    assert.ok(run);
    assert.equal(run.pipelineId, 'pipe-3');
    assert.equal(run.finalStatus, 'failed');
    assert.ok(run.totalDurationMs !== undefined);
    assert.ok(run.completedAt instanceof Date);
  });

  it('should compute summary across multiple runs', () => {
    // Run 1 — success
    service.startStage('run-a', 'scribe');
    service.endStage('run-a', 'scribe', true, { confidenceScore: 0.9 });
    service.startStage('run-a', 'proto');
    service.endStage('run-a', 'proto', true, { filesGenerated: 4 });

    // Run 2 — failure
    service.startStage('run-b', 'scribe');
    service.endStage('run-b', 'scribe', true, { confidenceScore: 0.7 });
    service.startStage('run-b', 'proto');
    service.endStage('run-b', 'proto', false, {});

    const summary = service.getSummary();
    assert.equal(summary.totalRuns, 2);
    // run-a ended with proto success -> completed; run-b ended with proto fail -> failed
    assert.equal(summary.successRate, 0.5);
    assert.ok(summary.avgDurationMs >= 0);
    // avg of 0.9 and 0.7 = 0.8
    assert.ok(
      Math.abs(summary.avgScribeConfidence - 0.8) < 0.001,
      `expected ~0.8, got ${summary.avgScribeConfidence}`,
    );
  });

  it('should throw when ending a stage that was never started', () => {
    assert.throws(
      () => service.endStage('pipe-x', 'proto', true, {}),
      {
        message: /stage was never started/,
      },
    );
  });

  it('should return an empty summary when no runs exist', () => {
    const summary = service.getSummary();
    assert.equal(summary.totalRuns, 0);
    assert.equal(summary.successRate, 0);
    assert.equal(summary.avgDurationMs, 0);
    assert.equal(summary.avgScribeConfidence, 0);
    assert.equal(summary.avgCriticScore, 0);
    assert.equal(summary.fixLoopStats.avgIterations, 0);
    assert.equal(summary.fixLoopStats.fixSuccessRate, 0);
  });

  it('should return undefined for a non-existent pipeline', () => {
    const run = service.getRunMetrics('does-not-exist');
    assert.equal(run, undefined);
  });

  it('should compute fix loop stats correctly', () => {
    service.startStage('fix-run', 'fix_loop');
    service.endStage('fix-run', 'fix_loop', true, { iterationCount: 3 });

    service.startStage('fix-run-2', 'fix_loop');
    service.endStage('fix-run-2', 'fix_loop', false, { iterationCount: 5 });

    const summary = service.getSummary();
    assert.equal(summary.fixLoopStats.avgIterations, 4); // (3+5)/2
    assert.equal(summary.fixLoopStats.fixSuccessRate, 0.5); // 1 success out of 2
  });
});
