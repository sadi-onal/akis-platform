import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCAFFOLD_SYSTEM_PROMPT } from '../../src/pipeline/agents/proto/ProtoAgent.js';

describe('SCAFFOLD_SYSTEM_PROMPT', () => {
  it('includes the AKIS teal primary CSS variable', () => {
    assert.ok(SCAFFOLD_SYSTEM_PROMPT.includes('--primary:#07D1AF'));
  });

  it('declares FORBIDDEN rules so the model refuses unsupported patterns', () => {
    assert.ok(SCAFFOLD_SYSTEM_PROMPT.includes('FORBIDDEN'));
  });

  it('requires localStorage-based persistence for stateful scaffolds', () => {
    assert.ok(SCAFFOLD_SYSTEM_PROMPT.includes('localStorage'));
  });

  it('no longer suggests the Tailwind max-w-7xl mx-auto container pattern', () => {
    assert.ok(!SCAFFOLD_SYSTEM_PROMPT.includes('max-w-7xl mx-auto'));
  });
});
