/**
 * P5a: AIService observer carries prompt/response content for `job_ai_calls`.
 *
 * The MockAIService path is what runs in CI (NODE_ENV=test forces mock), so
 * we drive it directly here and assert that every mocked call hands the
 * observer a populated `content` payload. The persistence layer
 * (TraceRecorder) trusts these fields; if MockAIService ever stops emitting
 * them this test will catch the regression.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';

import { createAIService } from '../../src/services/ai/AIService.js';
import type { AICallMetrics, AIServiceObserver } from '../../src/services/ai/AIService.js';
import type { AIConfig } from '../../src/config/env.js';

function makeMockConfig(): AIConfig {
  return {
    provider: 'mock',
    modelDefault: 'mock-model',
    modelPlanner: 'mock-model',
    modelValidation: 'mock-model',
  };
}

function captureObserver(): { calls: AICallMetrics[]; observer: AIServiceObserver } {
  const calls: AICallMetrics[] = [];
  return {
    calls,
    observer: { onAiCall: (m) => calls.push(m) },
  };
}

describe('AIService observer — P5a content payload', () => {
  test('MockAIService.planTask emits content with system + user prompts and response', async () => {
    const { calls, observer } = captureObserver();
    const service = createAIService(makeMockConfig(), observer);

    await service.planTask({ agent: 'scribe', goal: 'add a thing' });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.purpose, 'plan');
    assert.strictEqual(call.provider, 'mock');
    assert.ok(call.content, 'expected content payload');
    assert.ok(call.content.systemPrompt, 'systemPrompt populated');
    assert.ok(call.content.userPrompt?.includes('scribe'), 'userPrompt references agent');
    assert.ok(call.content.userPrompt?.includes('add a thing'), 'userPrompt references goal');
    assert.ok(call.content.responseText, 'responseText populated');
    // Plan response is JSON; should parse.
    const parsed = JSON.parse(call.content.responseText!);
    assert.ok(Array.isArray(parsed.steps));
  });

  test('MockAIService.generateWorkArtifact emits content with task + system prompt + response', async () => {
    const { calls, observer } = captureObserver();
    const service = createAIService(makeMockConfig(), observer);

    await service.generateWorkArtifact({
      task: 'build hello world',
      systemPrompt: 'You are Proto. Return scaffold files.',
    });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.purpose, 'generate');
    assert.strictEqual(call.content?.systemPrompt, 'You are Proto. Return scaffold files.');
    assert.strictEqual(call.content?.userPrompt, 'build hello world');
    assert.ok(call.content?.responseText);
  });

  test('MockAIService.reflectOnArtifact emits content with critique JSON', async () => {
    const { calls, observer } = captureObserver();
    const service = createAIService(makeMockConfig(), observer);

    await service.reflectOnArtifact({ artifact: 'some scaffold' });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.purpose, 'reflect');
    assert.strictEqual(call.content?.userPrompt, 'some scaffold');
    assert.ok(call.content?.responseText);
    const parsed = JSON.parse(call.content!.responseText!);
    assert.ok(Array.isArray(parsed.issues));
  });

  test('MockAIService.validateWithStrongModel emits content with result JSON', async () => {
    const { calls, observer } = captureObserver();
    const service = createAIService(makeMockConfig(), observer);

    await service.validateWithStrongModel({ artifact: { foo: 'bar' } });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.purpose, 'validate');
    assert.ok(call.content?.userPrompt?.includes('foo'), 'userPrompt serialises artifact');
    assert.ok(call.content?.responseText);
    const parsed = JSON.parse(call.content!.responseText!);
    assert.strictEqual(parsed.passed, true);
  });
});
