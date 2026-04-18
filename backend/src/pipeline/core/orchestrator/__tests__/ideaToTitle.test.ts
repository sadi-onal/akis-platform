import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ideaToTitle } from '../PipelineOrchestrator.js';

describe('ideaToTitle', () => {
  it('returns the idea untouched when it is a single short line', () => {
    assert.equal(ideaToTitle('Build a todo app with React'), 'Build a todo app with React');
  });

  it('returns only the first line of a multi-line engineer-started idea (BUG-25)', () => {
    const idea =
      'Implement proper logging and monitoring infrastructure\n\n' +
      'Set up structured logging (Winston, Pino, or similar) for all services.';
    assert.equal(
      ideaToTitle(idea),
      'Implement proper logging and monitoring infrastructure',
    );
  });

  it('trims whitespace around the first line', () => {
    assert.equal(ideaToTitle('   spaced title   \n\ndescription'), 'spaced title');
  });

  it('caps the result at 100 characters', () => {
    const longLine = 'x'.repeat(250);
    assert.equal(ideaToTitle(longLine).length, 100);
  });

  it('returns an empty string for an empty idea', () => {
    assert.equal(ideaToTitle(''), '');
  });

  it('returns an empty string when the first line is whitespace-only (contract: caller/fallback handles empty)', () => {
    assert.equal(ideaToTitle('   \n\nreal description here'), '');
  });
});
