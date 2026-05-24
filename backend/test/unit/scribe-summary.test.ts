import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ScribeOutputSchema } from '../../src/pipeline/core/contracts/PipelineSchemas.js';

// Pattern A — Scribe LLM summary parse (2026-05-23).
// These tests assert the contract change: ScribeOutputSchema accepts an
// optional `summary` field (1-3 sentence Turkish narration) and rejects
// nothing extra. Real prompt round-trip is covered by integration tests.

describe('Scribe summary parse', () => {
  it('accepts an output with a summary field', () => {
    const obj = {
      spec: {
        title: 'Sayaç',
        problemStatement: 'Basit sayaç uygulaması.',
        userStories: [{ persona: 'Kullanıcı', action: 'Sayacı artır', benefit: 'Takip' }],
        acceptanceCriteria: [
          { id: 'ac-1', given: 'Sayaç sıfır', when: '+ tıklanır', then: 'Sayı 1 olur' },
        ],
        technicalConstraints: {},
        outOfScope: [],
      },
      plan: {
        projectName: 'Sayaç',
        summary: 'Sayaç uygulaması.',
        features: [{ name: 'Sayaç', description: 'Artır azalt' }],
        techChoices: [],
        estimatedFiles: 5,
        requiresTests: true,
      },
      rawMarkdown: '# Sayaç',
      confidence: 0.9,
      clarificationsAsked: 0,
      reviewNotes: { selfReviewPassed: true },
      summary: 'Sayaç için 5 user story belirledim — artır, azalt, sıfırla.',
    };
    const parsed = ScribeOutputSchema.safeParse(obj);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(
        parsed.data.summary,
        'Sayaç için 5 user story belirledim — artır, azalt, sıfırla.'
      );
    }
  });

  it('accepts an output without a summary field (legacy compatibility)', () => {
    const obj = {
      spec: {
        title: 'Sayaç',
        problemStatement: 'Basit sayaç.',
        userStories: [{ persona: 'Kullanıcı', action: 'Artır', benefit: 'Takip' }],
        acceptanceCriteria: [
          { id: 'ac-1', given: 'Sıfır', when: '+ tıklanır', then: 'Bir olur' },
        ],
        technicalConstraints: {},
        outOfScope: [],
      },
      plan: {
        projectName: 'Sayaç',
        summary: 'Sayaç.',
        features: [{ name: 'Sayaç', description: 'Artır' }],
        techChoices: [],
        estimatedFiles: 5,
        requiresTests: true,
      },
      rawMarkdown: '# Sayaç',
      confidence: 0.9,
      clarificationsAsked: 0,
      reviewNotes: { selfReviewPassed: true },
    };
    const parsed = ScribeOutputSchema.safeParse(obj);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.summary, undefined);
    }
  });

  it('plain JSON parse: picks up summary field', () => {
    const json = '{"spec":{},"summary":"Sayaç için 5 user story belirledim."}';
    const parsed = JSON.parse(json);
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : undefined;
    assert.equal(summary, 'Sayaç için 5 user story belirledim.');
  });

  it('plain JSON parse: returns undefined when summary missing', () => {
    const json = '{"spec":{}}';
    const parsed = JSON.parse(json);
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : undefined;
    assert.equal(summary, undefined);
  });
});
