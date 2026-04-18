/**
 * Adapter that maps the narrow EngineerSessionOrchestrator surface onto the
 * full PipelineOrchestrator. The mechanical risk is that `engineerSessionId`
 * (4th on the interface) must land in the 8th slot of the underlying call;
 * this test pins that positional mapping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toEngineerSessionOrchestrator } from '../engineer.plugin.js';
import type { PipelineOrchestrator } from '../../core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState, ScribeInput } from '../../core/contracts/PipelineTypes.js';

function makePipelineState(id: string): PipelineState {
  return {
    id,
    userId: 'user-1',
    stage: 'scribe_clarifying',
    scribeConversation: [],
    traceEnabled: false,
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
  } as unknown as PipelineState;
}

describe('toEngineerSessionOrchestrator', () => {
  it('forwards engineerSessionId into the 8th positional argument of PipelineOrchestrator.startPipeline', async () => {
    const calls: unknown[][] = [];
    const orchestrator = {
      startPipeline: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(makePipelineState('pipe-1'));
      },
      getStatus: () => Promise.resolve(makePipelineState('pipe-1')),
      approveSpec: () => Promise.resolve(makePipelineState('pipe-1')),
    } as unknown as PipelineOrchestrator;

    const adapter = toEngineerSessionOrchestrator(orchestrator);
    const input: ScribeInput = { idea: 'Fix the login form', targetStack: 'typescript' };
    await adapter.startPipeline('user-1', input, 'claude-sonnet-4-6', 'sess-42');

    assert.equal(calls.length, 1, 'exactly one startPipeline call issued');
    const [userId, scribeInput, model, jira, parent, skip, trace, sessionId] = calls[0];
    assert.equal(userId, 'user-1');
    assert.equal(scribeInput, input);
    assert.equal(model, 'claude-sonnet-4-6');
    assert.equal(jira, undefined, 'jiraConfig slot passes undefined');
    assert.equal(parent, undefined, 'parentPipelineId slot passes undefined');
    assert.equal(skip, undefined, 'skipScribe slot passes undefined');
    assert.equal(trace, undefined, 'traceEnabled slot passes undefined');
    assert.equal(sessionId, 'sess-42', 'engineerSessionId lands in the 8th slot');
  });
});
