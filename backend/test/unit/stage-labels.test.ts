import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stageLabelTR } from '../../src/pipeline/core/utils/stageLabels.js';

describe('stageLabelTR', () => {
  it('maps scribe stages to "Fikir analiz adımı"', () => {
    assert.equal(stageLabelTR('scribe_clarifying'), 'Fikir analiz adımı');
    assert.equal(stageLabelTR('scribe_generating'), 'Fikir analiz adımı');
  });
  it('maps proto_building to "Kod üretim adımı"', () => {
    assert.equal(stageLabelTR('proto_building'), 'Kod üretim adımı');
  });
  it('maps trace_testing to "Test üretim adımı"', () => {
    assert.equal(stageLabelTR('trace_testing'), 'Test üretim adımı');
  });
  it('maps critic stages to "İnceleme adımı"', () => {
    assert.equal(stageLabelTR('critic_reviewing_spec'), 'İnceleme adımı');
    assert.equal(stageLabelTR('critic_reviewing_code'), 'İnceleme adımı');
  });
  it('falls back to "İşlem" for unmapped/terminal stages', () => {
    assert.equal(stageLabelTR('completed'), 'İşlem');
    assert.equal(stageLabelTR('failed'), 'İşlem');
    assert.equal(stageLabelTR('cancelled'), 'İşlem');
  });
});
