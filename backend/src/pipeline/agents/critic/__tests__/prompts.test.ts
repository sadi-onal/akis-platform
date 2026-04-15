import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEC_REVIEW_SYSTEM_PROMPT,
  buildSpecReviewUserPrompt,
} from '../prompts/spec-review.js';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewUserPrompt,
} from '../prompts/code-review.js';

// ─── Spec Review Prompt Tests ────────────────────

describe('Spec review prompt', () => {
  it('system prompt contains all 5 review criteria', () => {
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('Completeness'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('Ambiguity'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('Testability'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('Consistency'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('Technical Feasibility'));
  });

  it('system prompt specifies weighted scoring', () => {
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('weight: 0.25'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('weight: 0.20'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('weight: 0.15'));
  });

  it('system prompt defines approval threshold of 75', () => {
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('>= 75'));
  });

  it('system prompt emphasizes fresh context / independent review', () => {
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('INDEPENDENT'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('did NOT write'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('fresh eyes'));
  });

  it('system prompt requires JSON output format', () => {
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('valid JSON'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('"approved"'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('"overallScore"'));
    assert.ok(SPEC_REVIEW_SYSTEM_PROMPT.includes('"findings"'));
  });

  it('user prompt includes original idea', () => {
    const prompt = buildSpecReviewUserPrompt({ title: 'test' }, 'My idea', 1);
    assert.ok(prompt.includes('My idea'));
  });

  it('user prompt includes iteration number', () => {
    const prompt = buildSpecReviewUserPrompt({ title: 'test' }, 'idea', 3);
    assert.ok(prompt.includes('REVIEW ITERATION: 3'));
  });

  it('user prompt includes serialized artifact', () => {
    const artifact = { title: 'Test App', problemStatement: 'Test problem' };
    const prompt = buildSpecReviewUserPrompt(artifact, 'idea', 1);
    assert.ok(prompt.includes('Test App'));
    assert.ok(prompt.includes('Test problem'));
  });
});

// ─── Code Review Prompt Tests ────────────────────

describe('Code review prompt', () => {
  it('system prompt contains all 5 review criteria', () => {
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('Spec Compliance'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('Code Quality'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('Security'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('Completeness'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('Testability'));
  });

  it('system prompt weights spec compliance highest at 0.35', () => {
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('weight: 0.35'));
  });

  it('system prompt emphasizes fresh context / independent review', () => {
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('INDEPENDENT'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('did NOT write'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('fresh eyes'));
  });

  it('system prompt requires JSON output format', () => {
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('valid JSON'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('"approved"'));
    assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes('"findings"'));
  });

  it('user prompt includes reference spec for compliance', () => {
    const spec = { title: 'Reference Spec' };
    const code = { files: [] };
    const prompt = buildCodeReviewUserPrompt(code, 'idea', spec, 1);
    assert.ok(prompt.includes('Reference Spec'));
    assert.ok(prompt.includes('APPROVED SPEC'));
  });

  it('user prompt includes code artifact', () => {
    const spec = { title: 'Spec' };
    const code = { files: [{ filePath: 'src/App.jsx' }] };
    const prompt = buildCodeReviewUserPrompt(code, 'idea', spec, 1);
    assert.ok(prompt.includes('src/App.jsx'));
    assert.ok(prompt.includes('CODE OUTPUT TO REVIEW'));
  });

  it('user prompt includes iteration number', () => {
    const prompt = buildCodeReviewUserPrompt({}, 'idea', {}, 5);
    assert.ok(prompt.includes('REVIEW ITERATION: 5'));
  });
});
