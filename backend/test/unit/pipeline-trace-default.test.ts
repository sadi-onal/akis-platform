import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StartPipelineRequestSchema } from '../../src/pipeline/core/contracts/PipelineSchemas.js';

describe('StartPipelineRequestSchema.traceEnabled (PR-A: opt-out, not opt-in)', () => {
  const baseInput = { idea: 'Build a todo app' };

  it('defaults to true when omitted', () => {
    const parsed = StartPipelineRequestSchema.parse(baseInput);
    assert.equal(parsed.traceEnabled, true);
  });

  it('respects explicit false (user opted out)', () => {
    const parsed = StartPipelineRequestSchema.parse({ ...baseInput, traceEnabled: false });
    assert.equal(parsed.traceEnabled, false);
  });

  it('respects explicit true', () => {
    const parsed = StartPipelineRequestSchema.parse({ ...baseInput, traceEnabled: true });
    assert.equal(parsed.traceEnabled, true);
  });
});
