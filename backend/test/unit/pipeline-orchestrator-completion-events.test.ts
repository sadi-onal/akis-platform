/**
 * Chat narrator (Pattern A) — completion event payload contract tests
 * (2026-05-23, Task 4).
 *
 * Validates that the discriminated union for ScribeMessageType accepts the
 * new fields (`scribe_completed`, `durationMs`, `subSteps`, optional `summary`
 * on `trace_completed`). Type-level assertions guarantee compile-time coverage;
 * value assertions guard against accidental field renames.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ScribeMessageType,
  SubStep,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

describe('chat-narrator completion events', () => {
  it('scribe_completed payload shape', () => {
    const sample: Extract<ScribeMessageType, { type: 'scribe_completed' }> = {
      type: 'scribe_completed',
      content: {
        iteration: 1,
        summary: 'Plan hazırlandı.',
        storyCount: 5,
        acCount: 8,
        durationMs: 134000,
        subSteps: [
          {
            label: "User story'ler çıkarıldı",
            status: 'done',
            durationMs: 42000,
            source: 'agent',
          },
          { label: 'Değerlendirme: 2 eksik nokta', status: 'done', source: 'critic' },
        ],
      },
      timestamp: '2026-05-23T22:27:00Z',
    };
    assert.equal(sample.content.iteration, 1);
    assert.equal(sample.content.summary, 'Plan hazırlandı.');
    assert.equal(sample.content.storyCount, 5);
    assert.equal(sample.content.acCount, 8);
    assert.equal(sample.content.subSteps?.[1].source, 'critic');
  });

  it('trace_completed accepts optional summary + durationMs + subSteps', () => {
    const sample: Extract<ScribeMessageType, { type: 'trace_completed' }> = {
      type: 'trace_completed',
      content: {
        iteration: 1,
        totalTests: 21,
        coverage: 100,
        passed: true,
        summary: '21 test yazdım.',
        durationMs: 47000,
      },
      timestamp: '2026-05-23T22:33:00Z',
    };
    assert.equal(sample.content.summary, '21 test yazdım.');
    assert.equal(sample.content.durationMs, 47000);
  });

  it('proto_completed accepts optional durationMs + subSteps', () => {
    const sample: Extract<ScribeMessageType, { type: 'proto_completed' }> = {
      type: 'proto_completed',
      content: {
        iteration: 1,
        summary: 'Proje dosyaları hazır.',
        filesCreated: 13,
        totalLines: 440,
        branch: 'feat/sayac',
        durationMs: 98000,
        subSteps: [
          { label: 'İskelet üretildi', status: 'done', source: 'agent' },
          { label: 'Statik kontrol: temiz', status: 'done', source: 'validator' },
        ],
      },
      timestamp: '2026-05-23T22:28:00Z',
    };
    assert.equal(sample.content.durationMs, 98000);
    assert.equal(sample.content.subSteps?.length, 2);
  });

  it('SubStep accepts all source values', () => {
    const agent: SubStep = { label: 'x', status: 'done', source: 'agent' };
    const critic: SubStep = { label: 'x', status: 'done', source: 'critic' };
    const validator: SubStep = { label: 'x', status: 'live', source: 'validator' };
    const failed: SubStep = { label: 'x', status: 'failed' };
    assert.equal(agent.source, 'agent');
    assert.equal(critic.source, 'critic');
    assert.equal(validator.source, 'validator');
    assert.equal(failed.source, undefined);
  });

  it('SubStep status is restricted to done|live|failed', () => {
    // @ts-expect-error -- 'pending' is not a valid SubStep status
    const bad: SubStep = { label: 'x', status: 'pending' };
    void bad;
  });
});
