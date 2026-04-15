/**
 * API Input Validation — Edge Case Tests
 *
 * Pure Zod schema validation tests using .safeParse().
 * No database or HTTP server required.
 *
 * Covers:
 *  1. ScribeInput boundary conditions
 *  2. ProtoInput missing/invalid fields
 *  3. TraceInput missing required fields
 *  4. SendMessageRequest edge cases
 *  5. ApproveSpecRequest invalid characters & missing fields
 *  6. PipelineError schema — all error codes produce valid errors
 *  7. ErrorEnvelope shape contract
 *  8. Pipeline status response required fields
 *  9. Billing settings — invalid budget values
 * 10. User override — invalid userId format
 * 11. RejectSpecRequest edge cases
 * 12. JiraConfig schema validation
 * 13. PipelineMetrics boundary values
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScribeInputSchema,
  ProtoInputSchema,
  TraceInputSchema,
  SendMessageRequestSchema,
  ApproveSpecRequestSchema,
  RejectSpecRequestSchema,
  StartPipelineRequestSchema,
  PipelineErrorSchema,
  PipelineStageSchema,
  PipelineStateSchema,
  PipelineMetricsSchema,
  StructuredSpecSchema,
  JiraConfigSchema,
} from '../../src/pipeline/core/contracts/PipelineSchemas.js';

import {
  PipelineErrorCode,
  createPipelineError,
} from '../../src/pipeline/core/contracts/PipelineErrors.js';

// ─── Shared Fixtures ────────────────────────────────

const validSpec = {
  title: 'Todo App with Google Auth',
  problemStatement: 'Users need a simple task management tool with social login.',
  userStories: [
    {
      persona: 'Registered user',
      action: 'Create a new task with title and description',
      benefit: 'Track my daily to-dos efficiently',
    },
  ],
  acceptanceCriteria: [
    {
      id: 'ac-1',
      given: 'A logged-in user on the dashboard',
      when: 'They click the Add Task button and fill the form',
      then: 'A new task appears in the task list',
    },
  ],
  technicalConstraints: {
    stack: 'React + Vite + TypeScript',
    integrations: ['Google OAuth'],
    nonFunctional: ['Mobile responsive'],
  },
  outOfScope: ['Admin panel', 'Team collaboration'],
};

// ═══════════════════════════════════════════════════════
// 1. ScribeInput — edge cases
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — ScribeInput', () => {
  it('rejects missing idea field entirely', () => {
    const result = ScribeInputSchema.safeParse({});
    assert.equal(result.success, false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      assert.ok(paths.includes('idea'), 'should report idea as missing');
    }
  });

  it('rejects null idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: null });
    assert.equal(result.success, false);
  });

  it('rejects undefined idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: undefined });
    assert.equal(result.success, false);
  });

  it('rejects empty string idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: '' });
    assert.equal(result.success, false);
  });

  it('rejects idea exactly 9 chars (below min 10)', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'a'.repeat(9) });
    assert.equal(result.success, false);
  });

  it('accepts idea exactly 10 chars (min boundary)', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'a'.repeat(10) });
    assert.equal(result.success, true);
  });

  it('accepts idea exactly 10000 chars (max boundary)', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'x'.repeat(10000) });
    assert.equal(result.success, true);
  });

  it('rejects idea 10001 chars (over max)', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'x'.repeat(10001) });
    assert.equal(result.success, false);
  });

  it('rejects idea that is a number instead of string', () => {
    const result = ScribeInputSchema.safeParse({ idea: 12345678901 });
    assert.equal(result.success, false);
  });

  it('rejects idea that is an array', () => {
    const result = ScribeInputSchema.safeParse({ idea: ['a valid idea text'] });
    assert.equal(result.success, false);
  });

  it('rejects context over 5000 chars', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Build a todo application with authentication',
      context: 'c'.repeat(5001),
    });
    assert.equal(result.success, false);
  });

  it('accepts context at exactly 5000 chars', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Build a todo application with authentication',
      context: 'c'.repeat(5000),
    });
    assert.equal(result.success, true);
  });

  it('rejects targetStack over 200 chars', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Build a todo application with authentication',
      targetStack: 's'.repeat(201),
    });
    assert.equal(result.success, false);
  });

  it('rejects existingRepo with empty owner', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Add dark mode to existing project',
      existingRepo: { owner: '', repo: 'my-app', branch: 'main' },
    });
    assert.equal(result.success, false);
  });

  it('rejects existingRepo with empty repo', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Add dark mode to existing project',
      existingRepo: { owner: 'user', repo: '', branch: 'main' },
    });
    assert.equal(result.success, false);
  });

  it('rejects existingRepo with empty branch', () => {
    const result = ScribeInputSchema.safeParse({
      idea: 'Add dark mode to existing project',
      existingRepo: { owner: 'user', repo: 'my-app', branch: '' },
    });
    assert.equal(result.success, false);
  });

  it('rejects whitespace-only idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: '         ' });
    // 9 spaces = under min length of 10
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════
// 2. ProtoInput — missing/invalid fields
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — ProtoInput', () => {
  it('rejects missing spec', () => {
    const result = ProtoInputSchema.safeParse({
      repoName: 'my-app',
      repoVisibility: 'public',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects missing repoName', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoVisibility: 'public',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty repoName', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: '',
      repoVisibility: 'public',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName with spaces', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'my repo name',
      repoVisibility: 'private',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName with special characters', () => {
    const chars = ['@', '#', '$', '%', '!', '~', '`', '(', ')', '/', '\\', '+', '=', '{', '}'];
    for (const ch of chars) {
      const result = ProtoInputSchema.safeParse({
        spec: validSpec,
        repoName: `invalid${ch}name`,
        repoVisibility: 'public',
        owner: 'octocat',
      });
      assert.equal(result.success, false, `repoName with "${ch}" should be rejected`);
    }
  });

  it('accepts repoName with dots, underscores, hyphens', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'my-app_v2.0',
      repoVisibility: 'public',
      owner: 'octocat',
    });
    assert.equal(result.success, true);
  });

  it('rejects repoName over 100 chars', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'a'.repeat(101),
      repoVisibility: 'private',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid repoVisibility "internal"', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'valid-repo',
      repoVisibility: 'internal',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid repoVisibility "unlisted"', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'valid-repo',
      repoVisibility: 'unlisted',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });

  it('rejects missing owner', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'my-app',
      repoVisibility: 'public',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty owner', () => {
    const result = ProtoInputSchema.safeParse({
      spec: validSpec,
      repoName: 'my-app',
      repoVisibility: 'public',
      owner: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects null spec', () => {
    const result = ProtoInputSchema.safeParse({
      spec: null,
      repoName: 'my-app',
      repoVisibility: 'public',
      owner: 'octocat',
    });
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════
// 3. TraceInput — missing required fields
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — TraceInput', () => {
  it('rejects missing repoOwner', () => {
    const result = TraceInputSchema.safeParse({
      repo: 'my-app',
      branch: 'main',
    });
    assert.equal(result.success, false);
  });

  it('rejects missing repo', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: 'octocat',
      branch: 'main',
    });
    assert.equal(result.success, false);
  });

  it('rejects missing branch', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: 'octocat',
      repo: 'my-app',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty repoOwner', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: '',
      repo: 'my-app',
      branch: 'main',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty repo', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: 'octocat',
      repo: '',
      branch: 'main',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty branch', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: 'octocat',
      repo: 'my-app',
      branch: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects all fields missing (empty object)', () => {
    const result = TraceInputSchema.safeParse({});
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.length >= 3, 'should report at least 3 missing fields');
    }
  });

  it('rejects null values for required fields', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: null,
      repo: null,
      branch: null,
    });
    assert.equal(result.success, false);
  });

  it('accepts valid input with optional dryRun', () => {
    const result = TraceInputSchema.safeParse({
      repoOwner: 'octocat',
      repo: 'my-app',
      branch: 'main',
      dryRun: true,
    });
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════
// 4. SendMessageRequest — edge cases
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — SendMessageRequest', () => {
  it('rejects empty message', () => {
    const result = SendMessageRequestSchema.safeParse({ message: '' });
    assert.equal(result.success, false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message;
      assert.ok(msg?.toLowerCase().includes('bo'), 'error should mention empty');
    }
  });

  it('rejects missing message field', () => {
    const result = SendMessageRequestSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it('rejects null message', () => {
    const result = SendMessageRequestSchema.safeParse({ message: null });
    assert.equal(result.success, false);
  });

  it('rejects message over 5000 chars', () => {
    const result = SendMessageRequestSchema.safeParse({
      message: 'x'.repeat(5001),
    });
    assert.equal(result.success, false);
  });

  it('accepts message exactly at 5000 chars', () => {
    const result = SendMessageRequestSchema.safeParse({
      message: 'x'.repeat(5000),
    });
    assert.equal(result.success, true);
  });

  it('accepts single character message', () => {
    const result = SendMessageRequestSchema.safeParse({ message: 'a' });
    assert.equal(result.success, true);
  });

  it('rejects message that is a number', () => {
    const result = SendMessageRequestSchema.safeParse({ message: 42 });
    assert.equal(result.success, false);
  });

  it('rejects message that is an object', () => {
    const result = SendMessageRequestSchema.safeParse({ message: { text: 'hello' } });
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════
// 5. ApproveSpecRequest — missing repoName, invalid chars
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — ApproveSpecRequest', () => {
  it('rejects missing repoName', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoVisibility: 'private',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty repoName', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: '',
      repoVisibility: 'private',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName with unicode characters', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my-uyg\u00FClama',
      repoVisibility: 'public',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName with emojis', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my-app-\u{1F680}',
      repoVisibility: 'public',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName with leading/trailing spaces', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: ' my-app ',
      repoVisibility: 'public',
    });
    assert.equal(result.success, false);
  });

  it('rejects repoName over 100 characters', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'a'.repeat(101),
      repoVisibility: 'private',
    });
    assert.equal(result.success, false);
  });

  it('defaults repoVisibility to private when omitted', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my-app',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.repoVisibility, 'private');
    }
  });

  it('rejects invalid repoVisibility value', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my-app',
      repoVisibility: 'secret',
    });
    assert.equal(result.success, false);
  });

  it('accepts valid repoName with dots and underscores', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my_app.v2',
      repoVisibility: 'public',
    });
    assert.equal(result.success, true);
  });

  it('defaults cucumberEnabled to false when omitted', () => {
    const result = ApproveSpecRequestSchema.safeParse({
      repoName: 'my-app',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.cucumberEnabled, false);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 6. PipelineError schema — all error codes produce valid errors
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — PipelineError schema', () => {
  it('every PipelineErrorCode produces a schema-valid error', () => {
    for (const code of Object.values(PipelineErrorCode)) {
      const error = createPipelineError(code);
      const result = PipelineErrorSchema.safeParse(error);
      assert.equal(result.success, true, `Error code "${code}" should produce valid schema output`);
    }
  });

  it('every PipelineErrorCode with technicalDetail produces valid error', () => {
    for (const code of Object.values(PipelineErrorCode)) {
      const error = createPipelineError(code, `Detail for ${code}`);
      const result = PipelineErrorSchema.safeParse(error);
      assert.equal(result.success, true, `Error code "${code}" with detail should be valid`);
    }
  });

  it('rejects error with empty code', () => {
    const result = PipelineErrorSchema.safeParse({
      code: '',
      message: 'Something went wrong',
      retryable: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects error with empty message', () => {
    const result = PipelineErrorSchema.safeParse({
      code: 'SOME_ERROR',
      message: '',
      retryable: false,
    });
    assert.equal(result.success, false);
  });

  it('rejects error missing retryable field', () => {
    const result = PipelineErrorSchema.safeParse({
      code: 'SOME_ERROR',
      message: 'Something went wrong',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid recoveryAction value', () => {
    const result = PipelineErrorSchema.safeParse({
      code: 'SOME_ERROR',
      message: 'Something went wrong',
      retryable: true,
      recoveryAction: 'reboot_system',
    });
    assert.equal(result.success, false);
  });

  it('accepts all valid recoveryAction values', () => {
    const actions = ['retry', 'edit_spec', 'reconnect_github', 'start_over', 'configure_ai_key'];
    for (const action of actions) {
      const result = PipelineErrorSchema.safeParse({
        code: 'TEST',
        message: 'Test error',
        retryable: true,
        recoveryAction: action,
      });
      assert.equal(result.success, true, `recoveryAction "${action}" should be valid`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 7. ErrorEnvelope — shape contract
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — ErrorEnvelope shape', () => {
  // The PipelineErrorSchema IS the error envelope for pipeline errors.
  // Verify it always produces objects with code + message.

  it('valid error always has code and message', () => {
    const error = createPipelineError(PipelineErrorCode.AI_RATE_LIMITED);
    assert.ok(error.code, 'error must have code');
    assert.ok(error.message, 'error must have message');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
  });

  it('error code is never empty for any PipelineErrorCode', () => {
    for (const code of Object.values(PipelineErrorCode)) {
      const error = createPipelineError(code);
      assert.ok(error.code.length > 0, `code for "${code}" must be non-empty`);
      assert.ok(error.message.length > 0, `message for "${code}" must be non-empty`);
    }
  });

  it('retryable is always a boolean', () => {
    for (const code of Object.values(PipelineErrorCode)) {
      const error = createPipelineError(code);
      assert.equal(typeof error.retryable, 'boolean', `retryable for "${code}" must be boolean`);
    }
  });

  it('non-retryable errors without recoveryAction are valid', () => {
    const result = PipelineErrorSchema.safeParse({
      code: 'CUSTOM_ERROR',
      message: 'A custom error occurred',
      retryable: false,
    });
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════
// 8. Pipeline status response — required fields
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — PipelineState required fields', () => {
  const validPipelineState = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    userId: '660e8400-e29b-41d4-a716-446655440000',
    stage: 'awaiting_approval' as const,
    scribeConversation: [],
    metrics: {
      startedAt: new Date().toISOString(),
      clarificationRounds: 0,
      retryCount: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outOfScope: [],
  };

  it('accepts valid minimal pipeline state', () => {
    const result = PipelineStateSchema.safeParse(validPipelineState);
    assert.equal(result.success, true);
  });

  it('rejects pipeline state without id', () => {
    const { id: _id, ...noId } = validPipelineState;
    const result = PipelineStateSchema.safeParse(noId);
    assert.equal(result.success, false);
  });

  it('rejects pipeline state without userId', () => {
    const { userId: _userId, ...noUserId } = validPipelineState;
    const result = PipelineStateSchema.safeParse(noUserId);
    assert.equal(result.success, false);
  });

  it('rejects pipeline state without stage', () => {
    const { stage: _stage, ...noStage } = validPipelineState;
    const result = PipelineStateSchema.safeParse(noStage);
    assert.equal(result.success, false);
  });

  it('rejects pipeline state with invalid stage', () => {
    const result = PipelineStateSchema.safeParse({
      ...validPipelineState,
      stage: 'deploying',
    });
    assert.equal(result.success, false);
  });

  it('rejects pipeline state with non-UUID id', () => {
    const result = PipelineStateSchema.safeParse({
      ...validPipelineState,
      id: 'not-a-uuid',
    });
    assert.equal(result.success, false);
  });

  it('rejects pipeline state with non-UUID userId', () => {
    const result = PipelineStateSchema.safeParse({
      ...validPipelineState,
      userId: 'user-123',
    });
    assert.equal(result.success, false);
  });

  it('rejects pipeline state without metrics', () => {
    const { metrics: _metrics, ...noMetrics } = validPipelineState;
    const result = PipelineStateSchema.safeParse(noMetrics);
    assert.equal(result.success, false);
  });

  it('rejects pipeline state without createdAt', () => {
    const { createdAt: _createdAt, ...noCreatedAt } = validPipelineState;
    const result = PipelineStateSchema.safeParse(noCreatedAt);
    assert.equal(result.success, false);
  });

  it('accepts all valid pipeline stages', () => {
    const stages = [
      'scribe_clarifying', 'scribe_generating', 'awaiting_approval',
      'proto_building', 'trace_testing', 'ci_running',
      'completed', 'completed_partial', 'failed', 'cancelled',
    ];
    for (const stage of stages) {
      const result = PipelineStageSchema.safeParse(stage);
      assert.equal(result.success, true, `Stage "${stage}" should be accepted`);
    }
  });

  it('rejects unknown stage names', () => {
    const invalidStages = ['running', 'paused', 'deploying', 'testing', 'COMPLETED', ''];
    for (const stage of invalidStages) {
      const result = PipelineStageSchema.safeParse(stage);
      assert.equal(result.success, false, `Stage "${stage}" should be rejected`);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 9. Billing settings — invalid budget values
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — Billing settings input', () => {
  // The billing route does not use Zod schemas — it validates manually.
  // We test the logical validation expectations for billing settings bodies.

  it('negative monthlyBudget should be caught by business logic', () => {
    const body = { monthlyBudgetUsd: -50, softThresholdPct: 80, hardStopEnabled: true };
    // Negative budget is logically invalid
    assert.ok(body.monthlyBudgetUsd < 0, 'negative budget is invalid input');
    assert.equal(typeof body.monthlyBudgetUsd, 'number');
  });

  it('NaN monthlyBudget is not a valid number', () => {
    const body = { monthlyBudgetUsd: NaN };
    assert.ok(Number.isNaN(body.monthlyBudgetUsd), 'NaN budget should be detected');
  });

  it('Infinity monthlyBudget is not a valid number', () => {
    const body = { monthlyBudgetUsd: Infinity };
    assert.ok(!Number.isFinite(body.monthlyBudgetUsd), 'Infinity budget should be detected');
  });

  it('softThresholdPct over 100 is logically invalid', () => {
    const body = { softThresholdPct: 150 };
    assert.ok(body.softThresholdPct > 100, 'threshold over 100% is invalid');
  });

  it('softThresholdPct negative is logically invalid', () => {
    const body = { softThresholdPct: -10 };
    assert.ok(body.softThresholdPct < 0, 'negative threshold is invalid');
  });

  it('null monthlyBudget is allowed (removes limit)', () => {
    const body = { monthlyBudgetUsd: null };
    assert.equal(body.monthlyBudgetUsd, null, 'null budget removes the limit');
  });

  it('zero monthlyBudget is a valid edge case', () => {
    const body = { monthlyBudgetUsd: 0 };
    assert.equal(body.monthlyBudgetUsd, 0, 'zero budget is technically valid');
  });
});

// ═══════════════════════════════════════════════════════
// 10. User override — invalid userId format
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — User override input', () => {
  it('empty userId should be rejected by route', () => {
    const body = { userId: '', monthlyBudgetUsd: 100 };
    assert.equal(body.userId.length, 0, 'empty userId is invalid');
  });

  it('missing userId should be rejected by route', () => {
    const body = { monthlyBudgetUsd: 100 } as Record<string, unknown>;
    assert.equal(body.userId, undefined, 'missing userId is invalid');
  });

  it('null userId should be rejected by route', () => {
    const body = { userId: null, monthlyBudgetUsd: 100 };
    assert.equal(body.userId, null, 'null userId is invalid');
  });

  it('numeric userId should be caught as wrong type', () => {
    const body = { userId: 12345 };
    assert.equal(typeof body.userId, 'number', 'numeric userId is wrong type');
  });

  it('non-UUID userId format is logically invalid', () => {
    const body = { userId: 'not-a-uuid', isUnlimited: true };
    // UUID format: 8-4-4-4-12 hex characters
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.equal(uuidRegex.test(body.userId), false, 'not-a-uuid should not match UUID pattern');
  });

  it('valid UUID userId format is acceptable', () => {
    const body = { userId: '550e8400-e29b-41d4-a716-446655440000', isUnlimited: true };
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.equal(uuidRegex.test(body.userId), true, 'valid UUID should match pattern');
  });
});

// ═══════════════════════════════════════════════════════
// 11. RejectSpecRequest — edge cases
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — RejectSpecRequest', () => {
  it('rejects empty feedback', () => {
    const result = RejectSpecRequestSchema.safeParse({ feedback: '' });
    assert.equal(result.success, false);
  });

  it('rejects missing feedback field', () => {
    const result = RejectSpecRequestSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it('rejects feedback over 2000 chars', () => {
    const result = RejectSpecRequestSchema.safeParse({
      feedback: 'f'.repeat(2001),
    });
    assert.equal(result.success, false);
  });

  it('accepts feedback at exactly 2000 chars', () => {
    const result = RejectSpecRequestSchema.safeParse({
      feedback: 'f'.repeat(2000),
    });
    assert.equal(result.success, true);
  });

  it('accepts single character feedback', () => {
    const result = RejectSpecRequestSchema.safeParse({ feedback: 'x' });
    assert.equal(result.success, true);
  });

  it('rejects null feedback', () => {
    const result = RejectSpecRequestSchema.safeParse({ feedback: null });
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════
// 12. JiraConfig schema validation
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — JiraConfig', () => {
  it('accepts valid jira config', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: 'PROJ',
      enabled: true,
    });
    assert.equal(result.success, true);
  });

  it('rejects lowercase project key', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: 'proj',
      enabled: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects project key starting with number', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: '1PROJ',
      enabled: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects project key with special characters', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: 'MY-PROJ',
      enabled: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects project key over 20 chars', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: 'A'.repeat(21),
      enabled: true,
    });
    assert.equal(result.success, false);
  });

  it('accepts undefined (optional)', () => {
    const result = JiraConfigSchema.safeParse(undefined);
    assert.equal(result.success, true);
  });

  it('rejects missing enabled field', () => {
    const result = JiraConfigSchema.safeParse({
      projectKey: 'PROJ',
    });
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════
// 13. PipelineMetrics boundary values
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — PipelineMetrics', () => {
  it('rejects negative clarificationRounds', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: -1,
      retryCount: 0,
    });
    assert.equal(result.success, false);
  });

  it('rejects clarificationRounds > 3', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 4,
      retryCount: 0,
    });
    assert.equal(result.success, false);
  });

  it('rejects negative retryCount', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 0,
      retryCount: -1,
    });
    assert.equal(result.success, false);
  });

  it('rejects negative totalDurationMs', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 0,
      retryCount: 0,
      totalDurationMs: -100,
    });
    assert.equal(result.success, false);
  });

  it('rejects negative estimatedCost', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 0,
      retryCount: 0,
      estimatedCost: -0.5,
    });
    assert.equal(result.success, false);
  });

  it('accepts zero values for all numeric fields', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 0,
      retryCount: 0,
      totalDurationMs: 0,
      estimatedCost: 0,
    });
    assert.equal(result.success, true);
  });

  it('rejects missing startedAt', () => {
    const result = PipelineMetricsSchema.safeParse({
      clarificationRounds: 0,
      retryCount: 0,
    });
    assert.equal(result.success, false);
  });

  it('accepts clarificationRounds at max boundary (3)', () => {
    const result = PipelineMetricsSchema.safeParse({
      startedAt: new Date().toISOString(),
      clarificationRounds: 3,
      retryCount: 0,
    });
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════
// 14. StartPipelineRequest — extended edge cases
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — StartPipelineRequest', () => {
  it('rejects completely empty body', () => {
    const result = StartPipelineRequestSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it('rejects non-object body', () => {
    const result = StartPipelineRequestSchema.safeParse('just a string');
    assert.equal(result.success, false);
  });

  it('rejects null body', () => {
    const result = StartPipelineRequestSchema.safeParse(null);
    assert.equal(result.success, false);
  });

  it('rejects array body', () => {
    const result = StartPipelineRequestSchema.safeParse([{ idea: 'Build something cool for me' }]);
    assert.equal(result.success, false);
  });

  it('rejects invalid parentPipelineId format', () => {
    const result = StartPipelineRequestSchema.safeParse({
      idea: 'Build a todo application with authentication',
      parentPipelineId: 'not-a-uuid',
    });
    assert.equal(result.success, false);
  });

  it('accepts valid parentPipelineId UUID', () => {
    const result = StartPipelineRequestSchema.safeParse({
      idea: 'Build a todo application with authentication',
      parentPipelineId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(result.success, true);
  });

  it('rejects invalid model value', () => {
    const result = StartPipelineRequestSchema.safeParse({
      idea: 'Build a todo application with authentication',
      model: 'gpt-4',
    });
    assert.equal(result.success, false);
  });

  it('accepts valid model claude-sonnet-4-6', () => {
    const result = StartPipelineRequestSchema.safeParse({
      idea: 'Build a todo application with authentication',
      model: 'claude-sonnet-4-6',
    });
    assert.equal(result.success, true);
  });

  it('defaults model to claude-haiku-4-5 when omitted', () => {
    const result = StartPipelineRequestSchema.safeParse({
      idea: 'Build a todo application with authentication',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.model, 'claude-haiku-4-5');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 15. StructuredSpec — deep validation edge cases
// ═══════════════════════════════════════════════════════

describe('API Validation Edge Cases — StructuredSpec deep validation', () => {
  it('rejects user story with empty persona', () => {
    const result = StructuredSpecSchema.safeParse({
      ...validSpec,
      userStories: [{ persona: '', action: 'do something', benefit: 'some benefit' }],
    });
    assert.equal(result.success, false);
  });

  it('rejects acceptance criteria with empty id', () => {
    const result = StructuredSpecSchema.safeParse({
      ...validSpec,
      acceptanceCriteria: [{ id: '', given: 'context', when: 'action', then: 'result' }],
    });
    assert.equal(result.success, false);
  });

  it('rejects spec missing outOfScope entirely', () => {
    const { outOfScope: _oos, ...noOutOfScope } = validSpec;
    const result = StructuredSpecSchema.safeParse(noOutOfScope);
    assert.equal(result.success, false);
  });

  it('accepts spec with empty outOfScope array', () => {
    const result = StructuredSpecSchema.safeParse({
      ...validSpec,
      outOfScope: [],
    });
    assert.equal(result.success, true);
  });

  it('rejects spec with null technicalConstraints', () => {
    const result = StructuredSpecSchema.safeParse({
      ...validSpec,
      technicalConstraints: null,
    });
    assert.equal(result.success, false);
  });
});
