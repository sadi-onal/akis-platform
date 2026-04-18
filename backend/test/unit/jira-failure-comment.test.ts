/**
 * Unit tests for commentJiraWithFailure — #396 follow-up.
 *
 * Existing success-path tests live in backend/test/unit/jira-integration.test.ts.
 * This file covers only the new failure-comment helper: shape of the comment
 * body + graceful error swallow.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { commentJiraWithFailure } from '../../src/pipeline/integrations/jiraIntegration.js';
import type { JiraMCPService } from '../../src/services/mcp/adapters/JiraMCPService.js';

function makeJiraMock(
  addCommentImpl?: (key: string, body: string) => Promise<void> | void,
): { jira: JiraMCPService; calls: Array<{ key: string; body: string }> } {
  const calls: Array<{ key: string; body: string }> = [];
  const jira = {
    addComment: async (key: string, body: string) => {
      calls.push({ key, body });
      if (addCommentImpl) {
        await addCommentImpl(key, body);
      }
    },
    // Only addComment is invoked by commentJiraWithFailure; the other
    // JiraMCPService methods can stay unimplemented for this suite.
  } as unknown as JiraMCPService;
  return { jira, calls };
}

describe('commentJiraWithFailure', () => {
  it('posts a comment with stage, error code, message, and pipeline id', async () => {
    const { jira, calls } = makeJiraMock();
    await commentJiraWithFailure(jira, 'PROJ-42', {
      stage: 'Proto',
      errorCode: 'GITHUB_API_ERROR',
      errorMessage: 'Branch creation rejected: permission denied',
      retryable: true,
      pipelineId: 'pl-abc-123',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'PROJ-42');
    const body = calls[0].body;
    assert.ok(body.includes('AKIS pipeline failed'));
    assert.ok(body.includes('Stage: Proto'));
    assert.ok(body.includes('Error code: `GITHUB_API_ERROR`'));
    assert.ok(body.includes('permission denied'));
    assert.ok(body.includes('Retryable: yes'));
    assert.ok(body.includes('Pipeline: `pl-abc-123`'));
  });

  it('trims error messages longer than 500 chars so Jira accepts the payload', async () => {
    const { jira, calls } = makeJiraMock();
    const huge = 'x'.repeat(800);
    await commentJiraWithFailure(jira, 'PROJ-1', {
      stage: 'Trace',
      errorMessage: huge,
    });
    const body = calls[0].body;
    // 500 chars + ellipsis
    assert.ok(body.includes('x'.repeat(500) + '…'));
    assert.ok(!body.includes('x'.repeat(501)));
  });

  it('omits optional fields when not provided', async () => {
    const { jira, calls } = makeJiraMock();
    await commentJiraWithFailure(jira, 'PROJ-9', { stage: 'Scribe' });
    const body = calls[0].body;
    assert.ok(body.includes('Stage: Scribe'));
    assert.ok(!body.includes('Error code'));
    assert.ok(!body.includes('Error:'));
    assert.ok(!body.includes('Retryable:'));
    assert.ok(!body.includes('Pipeline:'));
  });

  it('renders non-retryable as "manual intervention required"', async () => {
    const { jira, calls } = makeJiraMock();
    await commentJiraWithFailure(jira, 'PROJ-7', {
      stage: 'Proto',
      retryable: false,
    });
    assert.ok(calls[0].body.includes('Retryable: no — manual intervention required'));
  });

  it('swallows Jira API errors instead of throwing (pipeline must not break)', async () => {
    const { jira } = makeJiraMock(() => {
      throw new Error('Jira 503 Service Unavailable');
    });
    // Should resolve without throwing even though addComment throws
    await commentJiraWithFailure(jira, 'PROJ-5', {
      stage: 'Critic',
      errorMessage: 'something',
    });
    assert.ok(true, 'did not throw');
  });

  it('accepts custom stage strings (not just the enum list)', async () => {
    const { jira, calls } = makeJiraMock();
    await commentJiraWithFailure(jira, 'PROJ-2', {
      stage: 'CustomStage',
    });
    assert.ok(calls[0].body.includes('Stage: CustomStage'));
  });
});
