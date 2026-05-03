/**
 * Studio & Agent Configuration edge-case tests
 * Covers: agent config schemas, studio session schemas,
 *         AI model listing logic, feedback validation edge cases
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validateFeedback } from '../../src/utils/feedback-validation.js';
import {
  isModelAllowed,
  isModelCompatibleWithProvider,
  detectProviderFromModel,
  getRecommendedModel,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_ANTHROPIC_MODELS,
  RECOMMENDED_MODELS,
} from '../../src/services/ai/modelAllowlist.js';

// ═══════════════════════════════════════════════════════════════════════
// Re-create Zod schemas from source modules for pure validation testing.
// The original modules register Fastify routes; importing them would
// pull in DB/server dependencies we do not want in unit tests.
// ═══════════════════════════════════════════════════════════════════════

const agentTypeSchema = z.enum(['scribe', 'trace', 'proto']);
const runtimeProfileSchema = z.enum(['deterministic', 'balanced', 'creative', 'custom']);

const scribeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  repositoryOwner: z.string().min(1).optional(),
  repositoryName: z.string().min(1).optional(),
  baseBranch: z.string().optional(),
  branchPattern: z.string().optional(),
  targetPlatform: z.enum(['confluence', 'notion', 'github_wiki', 'github_repo']).optional(),
  targetConfig: z.record(z.unknown()).optional(),
  triggerMode: z.enum(['on_pr_merge', 'scheduled', 'manual']).optional(),
  scheduleCron: z.string().optional().nullable(),
  prTitleTemplate: z.string().optional(),
  prBodyTemplate: z.string().optional().nullable(),
  autoMerge: z.boolean().optional(),
  includeGlobs: z.array(z.string()).optional().nullable(),
  excludeGlobs: z.array(z.string()).optional().nullable(),
  jobTimeoutSeconds: z.number().int().min(10).max(600).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  llmModelOverride: z.string().optional().nullable(),
  runtimeProfile: runtimeProfileSchema.optional(),
  temperatureValue: z.number().min(0).max(1).optional().nullable(),
  commandLevel: z.number().int().min(1).max(5).optional(),
}).superRefine((data, ctx) => {
  if (data.runtimeProfile === 'custom') {
    if (data.temperatureValue === null || data.temperatureValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'temperatureValue is required when runtimeProfile is custom',
        path: ['temperatureValue'],
      });
    }
  }
});

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(256),
  repoUrl: z.string().url().max(512).optional(),
  branch: z.string().max(256).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  state: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  workspace: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  state: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// Helper that mirrors the formatModelName in ai-models.ts
function formatModelName(modelId: string): string {
  if (modelId.includes('/')) {
    const [org, name] = modelId.split('/');
    const orgLabel = org.charAt(0).toUpperCase() + org.slice(1);
    const nameLabel = name
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `${orgLabel} ${nameLabel}`;
  }
  return modelId;
}

// ═══════════════════════════════════════════════════════════════════════
//  1. Agent Configuration — Create config with valid schema
// ═══════════════════════════════════════════════════════════════════════

describe('Config create — valid schema with agentType, model, temperature', () => {
  test('accepts scribe config with model override and deterministic profile', () => {
    const result = scribeConfigSchema.safeParse({
      llmModelOverride: 'gpt-4o',
      runtimeProfile: 'deterministic',
    });
    assert.equal(result.success, true);
  });

  test('accepts proto agent type', () => {
    assert.equal(agentTypeSchema.safeParse('proto').success, true);
  });

  test('accepts trace agent type', () => {
    assert.equal(agentTypeSchema.safeParse('trace').success, true);
  });

  test('accepts full config with all agent-relevant fields', () => {
    const result = scribeConfigSchema.safeParse({
      enabled: true,
      repositoryOwner: 'org',
      repositoryName: 'repo',
      llmModelOverride: 'gpt-4o-mini',
      runtimeProfile: 'balanced',
      commandLevel: 3,
      jobTimeoutSeconds: 120,
      maxRetries: 2,
    });
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  2. Temperature bounds (0-1 range for this schema, per source)
// ═══════════════════════════════════════════════════════════════════════

describe('Config temperature bounds', () => {
  test('accepts temperature 0 with custom profile', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: 0,
    });
    assert.equal(result.success, true);
  });

  test('accepts temperature 1 with custom profile', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: 1,
    });
    assert.equal(result.success, true);
  });

  test('accepts temperature 0.5 with custom profile', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: 0.5,
    });
    assert.equal(result.success, true);
  });

  test('rejects temperature below 0', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: -0.1,
    });
    assert.equal(result.success, false);
  });

  test('rejects temperature above 1', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: 1.01,
    });
    assert.equal(result.success, false);
  });

  test('rejects temperature 2 (outside 0-1 range)', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: 2,
    });
    assert.equal(result.success, false);
  });

  test('temperature null is allowed when runtimeProfile is not custom', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'balanced',
      temperatureValue: null,
    });
    assert.equal(result.success, true);
  });

  test('custom profile requires non-null temperature', () => {
    const result = scribeConfigSchema.safeParse({
      runtimeProfile: 'custom',
      temperatureValue: null,
    });
    assert.equal(result.success, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  3. Max tokens / job timeout validation
// ═══════════════════════════════════════════════════════════════════════

describe('Config max tokens / jobTimeoutSeconds validation', () => {
  test('accepts minimum jobTimeoutSeconds (10)', () => {
    assert.equal(scribeConfigSchema.safeParse({ jobTimeoutSeconds: 10 }).success, true);
  });

  test('accepts maximum jobTimeoutSeconds (600)', () => {
    assert.equal(scribeConfigSchema.safeParse({ jobTimeoutSeconds: 600 }).success, true);
  });

  test('rejects jobTimeoutSeconds below 10', () => {
    assert.equal(scribeConfigSchema.safeParse({ jobTimeoutSeconds: 9 }).success, false);
  });

  test('rejects jobTimeoutSeconds above 600', () => {
    assert.equal(scribeConfigSchema.safeParse({ jobTimeoutSeconds: 601 }).success, false);
  });

  test('rejects non-integer jobTimeoutSeconds', () => {
    assert.equal(scribeConfigSchema.safeParse({ jobTimeoutSeconds: 10.5 }).success, false);
  });

  test('accepts maxRetries at boundary 0', () => {
    assert.equal(scribeConfigSchema.safeParse({ maxRetries: 0 }).success, true);
  });

  test('accepts maxRetries at boundary 5', () => {
    assert.equal(scribeConfigSchema.safeParse({ maxRetries: 5 }).success, true);
  });

  test('rejects maxRetries above 5', () => {
    assert.equal(scribeConfigSchema.safeParse({ maxRetries: 6 }).success, false);
  });

  test('rejects maxRetries below 0', () => {
    assert.equal(scribeConfigSchema.safeParse({ maxRetries: -1 }).success, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  4. Agent type enum validation
// ═══════════════════════════════════════════════════════════════════════

describe('Config agentType enum validation', () => {
  test('accepts all valid agent types', () => {
    for (const t of ['scribe', 'trace', 'proto'] as const) {
      assert.equal(agentTypeSchema.safeParse(t).success, true);
    }
  });

  test('rejects uppercase variants', () => {
    for (const t of ['SCRIBE', 'Trace', 'PROTO']) {
      assert.equal(agentTypeSchema.safeParse(t).success, false, `${t} should be rejected`);
    }
  });

  test('rejects empty string', () => {
    assert.equal(agentTypeSchema.safeParse('').success, false);
  });

  test('rejects numeric input', () => {
    assert.equal(agentTypeSchema.safeParse(0).success, false);
  });

  test('rejects null and undefined', () => {
    assert.equal(agentTypeSchema.safeParse(null).success, false);
    assert.equal(agentTypeSchema.safeParse(undefined).success, false);
  });

  test('rejects non-existent agent types', () => {
    for (const t of ['builder', 'analyzer', 'planner', 'reviewer']) {
      assert.equal(agentTypeSchema.safeParse(t).success, false, `${t} should be rejected`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  5. Model selection per provider
// ═══════════════════════════════════════════════════════════════════════

describe('Config model selection per provider', () => {
  test('OpenAI default list includes gpt-4o-mini (kept for PR-B B5)', () => {
    assert.ok(DEFAULT_OPENAI_MODELS.includes('gpt-4o-mini'));
  });

  test('Anthropic default list includes claude-haiku-4-5-20251001', () => {
    assert.ok(DEFAULT_ANTHROPIC_MODELS.includes('claude-haiku-4-5-20251001'));
  });

  test('model in OpenAI list passes allowlist check', () => {
    assert.equal(isModelAllowed('gpt-4o-mini', DEFAULT_OPENAI_MODELS), true);
  });

  test('Anthropic model not in OpenAI list fails allowlist check', () => {
    assert.equal(isModelAllowed('claude-haiku-4-5-20251001', DEFAULT_OPENAI_MODELS), false);
  });

  test('Anthropic model passes Anthropic allowlist', () => {
    assert.equal(isModelAllowed('claude-sonnet-4-6', DEFAULT_ANTHROPIC_MODELS), true);
  });

  test('provider compatibility — OpenAI model on Anthropic is NOT OK', () => {
    assert.equal(isModelCompatibleWithProvider('gpt-4o-mini', 'anthropic'), false);
  });

  test('provider compatibility — Anthropic model on OpenAI is NOT OK', () => {
    assert.equal(isModelCompatibleWithProvider('claude-haiku-4-5-20251001', 'openai'), false);
  });

  test('unknown format model is compatible with any provider', () => {
    assert.equal(isModelCompatibleWithProvider('custom-finetune-v1', 'openai'), true);
    assert.equal(isModelCompatibleWithProvider('custom-finetune-v1', 'anthropic'), true);
  });

  test('recommended model exists for each provider (PR-A: anthropic + openai)', () => {
    assert.ok(getRecommendedModel('openai'));
    assert.ok(getRecommendedModel('anthropic'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  6. Config update — partial fields
// ═══════════════════════════════════════════════════════════════════════

describe('Config update — partial fields', () => {
  test('accepts single field update (enabled only)', () => {
    assert.equal(scribeConfigSchema.safeParse({ enabled: true }).success, true);
  });

  test('accepts repositoryOwner-only update', () => {
    assert.equal(scribeConfigSchema.safeParse({ repositoryOwner: 'newOwner' }).success, true);
  });

  test('accepts runtimeProfile change without other fields', () => {
    assert.equal(scribeConfigSchema.safeParse({ runtimeProfile: 'creative' }).success, true);
  });

  test('accepts commandLevel-only update', () => {
    assert.equal(scribeConfigSchema.safeParse({ commandLevel: 4 }).success, true);
  });

  test('accepts multiple partial fields together', () => {
    const result = scribeConfigSchema.safeParse({
      enabled: false,
      maxRetries: 1,
      autoMerge: true,
    });
    assert.equal(result.success, true);
  });

  test('accepts empty object (no fields)', () => {
    assert.equal(scribeConfigSchema.safeParse({}).success, true);
  });

  test('strips unknown extra fields (default Zod behavior)', () => {
    // superRefine produces ZodEffects — Zod strips unrecognized keys by default
    const result = scribeConfigSchema.safeParse({ unknownField: 'oops', enabled: true });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal((result.data as Record<string, unknown>).unknownField, undefined);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  7. Config delete — proper cleanup (schema-level)
// ═══════════════════════════════════════════════════════════════════════

describe('Config delete — schema validation for cleanup', () => {
  test('agentType must be valid for delete target', () => {
    // Simulates validating the route param before delete
    assert.equal(agentTypeSchema.safeParse('scribe').success, true);
    assert.equal(agentTypeSchema.safeParse('unknown').success, false);
  });

  test('runtimeProfile enum covers all 4 values', () => {
    for (const p of ['deterministic', 'balanced', 'creative', 'custom'] as const) {
      assert.equal(runtimeProfileSchema.safeParse(p).success, true);
    }
  });

  test('runtimeProfile rejects invalid value', () => {
    assert.equal(runtimeProfileSchema.safeParse('turbo').success, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  8. Studio — Create session schema
// ═══════════════════════════════════════════════════════════════════════

describe('Studio create session schema', () => {
  test('accepts valid session with all fields', () => {
    const result = createSessionSchema.safeParse({
      title: 'My Studio Session',
      repoUrl: 'https://github.com/org/repo',
      branch: 'feature/test',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.title, 'My Studio Session');
    }
  });

  test('accepts title-only session', () => {
    const result = createSessionSchema.safeParse({ title: 'Minimal' });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.repoUrl, undefined);
      assert.equal(result.data.branch, undefined);
    }
  });

  test('rejects empty title', () => {
    assert.equal(createSessionSchema.safeParse({ title: '' }).success, false);
  });

  test('rejects whitespace-only title', () => {
    assert.equal(createSessionSchema.safeParse({ title: '   ' }).success, false);
  });

  test('trims whitespace from title', () => {
    const result = createSessionSchema.safeParse({ title: '  Hello  ' });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.title, 'Hello');
    }
  });

  test('rejects title over 256 chars', () => {
    assert.equal(createSessionSchema.safeParse({ title: 'x'.repeat(257) }).success, false);
  });

  test('accepts title at 256 char boundary', () => {
    assert.equal(createSessionSchema.safeParse({ title: 'x'.repeat(256) }).success, true);
  });

  test('rejects invalid repoUrl', () => {
    assert.equal(createSessionSchema.safeParse({ title: 'T', repoUrl: 'not-a-url' }).success, false);
  });

  test('rejects repoUrl over 512 chars', () => {
    const longUrl = 'https://github.com/' + 'x'.repeat(500);
    assert.equal(createSessionSchema.safeParse({ title: 'T', repoUrl: longUrl }).success, false);
  });

  test('rejects branch over 256 chars', () => {
    assert.equal(
      createSessionSchema.safeParse({ title: 'T', branch: 'b'.repeat(257) }).success,
      false,
    );
  });

  test('rejects missing title entirely', () => {
    assert.equal(createSessionSchema.safeParse({}).success, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  9. Studio — Session state transitions: active -> paused -> completed
// ═══════════════════════════════════════════════════════════════════════

describe('Studio session state transitions', () => {
  const validStates = ['active', 'paused', 'completed', 'archived'] as const;

  test('all valid states are accepted by updateSessionSchema', () => {
    for (const state of validStates) {
      const result = updateSessionSchema.safeParse({ state });
      assert.equal(result.success, true, `state "${state}" should be valid`);
    }
  });

  test('active -> paused transition accepted', () => {
    const result = updateSessionSchema.safeParse({ state: 'paused' });
    assert.equal(result.success, true);
  });

  test('paused -> completed transition accepted', () => {
    const result = updateSessionSchema.safeParse({ state: 'completed' });
    assert.equal(result.success, true);
  });

  test('completed -> archived transition accepted', () => {
    const result = updateSessionSchema.safeParse({ state: 'archived' });
    assert.equal(result.success, true);
  });

  test('update can change state and title simultaneously', () => {
    const result = updateSessionSchema.safeParse({
      state: 'completed',
      title: 'Done Session',
    });
    assert.equal(result.success, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. Studio — Invalid state transitions rejected
// ═══════════════════════════════════════════════════════════════════════

describe('Studio invalid state transitions rejected', () => {
  test('rejects "running" as state value', () => {
    assert.equal(updateSessionSchema.safeParse({ state: 'running' }).success, false);
  });

  test('rejects "drafting" as state value', () => {
    assert.equal(updateSessionSchema.safeParse({ state: 'drafting' }).success, false);
  });

  test('rejects "deleted" as state value', () => {
    assert.equal(updateSessionSchema.safeParse({ state: 'deleted' }).success, false);
  });

  test('rejects numeric state', () => {
    assert.equal(updateSessionSchema.safeParse({ state: 1 }).success, false);
  });

  test('rejects boolean state', () => {
    assert.equal(updateSessionSchema.safeParse({ state: true }).success, false);
  });

  test('rejects empty string state', () => {
    assert.equal(updateSessionSchema.safeParse({ state: '' }).success, false);
  });

  test('rejects null state', () => {
    assert.equal(updateSessionSchema.safeParse({ state: null }).success, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 11. Studio — File management within session (workspace schema)
// ═══════════════════════════════════════════════════════════════════════

describe('Studio file management within session', () => {
  test('workspace accepts file tree as record', () => {
    const result = updateSessionSchema.safeParse({
      workspace: {
        files: [
          { path: 'src/index.ts', content: 'console.log("hello")' },
          { path: 'package.json', content: '{}' },
        ],
      },
    });
    assert.equal(result.success, true);
  });

  test('workspace accepts nested unknown objects', () => {
    const result = updateSessionSchema.safeParse({
      workspace: {
        files: [],
        openEditors: ['src/index.ts'],
        settings: { theme: 'dark' },
      },
    });
    assert.equal(result.success, true);
  });

  test('workspace accepts empty object', () => {
    assert.equal(updateSessionSchema.safeParse({ workspace: {} }).success, true);
  });

  test('metadata accepts arbitrary key-value pairs', () => {
    const result = updateSessionSchema.safeParse({
      metadata: { version: 1, lastAgent: 'scribe', tags: ['mvp'] },
    });
    assert.equal(result.success, true);
  });

  test('list query filters by state', () => {
    const result = listQuerySchema.safeParse({ state: 'active' });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.state, 'active');
    }
  });

  test('list query applies defaults', () => {
    const result = listQuerySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.limit, 20);
      assert.equal(result.data.offset, 0);
    }
  });

  test('list query rejects limit over 50', () => {
    assert.equal(listQuerySchema.safeParse({ limit: 51 }).success, false);
  });

  test('list query rejects negative offset', () => {
    assert.equal(listQuerySchema.safeParse({ offset: -1 }).success, false);
  });

  test('list query coerces string limit to number', () => {
    const result = listQuerySchema.safeParse({ limit: '10' });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.limit, 10);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. AI Models — List models by provider
// ═══════════════════════════════════════════════════════════════════════

describe('Model listing by provider', () => {
  test('OpenAI models list is non-empty array of strings', () => {
    assert.ok(Array.isArray(DEFAULT_OPENAI_MODELS));
    assert.ok(DEFAULT_OPENAI_MODELS.length > 0);
    for (const m of DEFAULT_OPENAI_MODELS) {
      assert.equal(typeof m, 'string');
    }
  });

  test('Anthropic models list is non-empty array of strings', () => {
    assert.ok(Array.isArray(DEFAULT_ANTHROPIC_MODELS));
    assert.ok(DEFAULT_ANTHROPIC_MODELS.length > 0);
    for (const m of DEFAULT_ANTHROPIC_MODELS) {
      assert.equal(typeof m, 'string');
    }
  });

  test('all OpenAI default models detected as openai provider', () => {
    for (const m of DEFAULT_OPENAI_MODELS) {
      assert.equal(detectProviderFromModel(m), 'openai', `${m} should be openai`);
    }
  });

  test('all Anthropic default models detected as anthropic provider', () => {
    for (const m of DEFAULT_ANTHROPIC_MODELS) {
      assert.equal(detectProviderFromModel(m), 'anthropic', `${m} should be anthropic`);
    }
  });

  test('no overlap between OpenAI and Anthropic default lists', () => {
    const overlap = DEFAULT_OPENAI_MODELS.filter((m) => DEFAULT_ANTHROPIC_MODELS.includes(m));
    assert.equal(overlap.length, 0, 'lists should not overlap');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. AI Models — Model metadata: context, naming, recommendations
// ═══════════════════════════════════════════════════════════════════════

describe('Model metadata — naming and recommendations', () => {
  test('formatModelName returns raw ID for simple models', () => {
    assert.equal(formatModelName('gpt-4o-mini'), 'gpt-4o-mini');
  });

  test('formatModelName returns raw ID for Anthropic IDs (PR-A: no slash branch)', () => {
    assert.equal(formatModelName('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  });

  test('recommended model for anthropic provider is set', () => {
    assert.equal(typeof RECOMMENDED_MODELS.anthropic, 'string');
    assert.ok(RECOMMENDED_MODELS.anthropic.length > 0);
  });

  test('recommended model for openai is in the default list', () => {
    const rec = getRecommendedModel('openai');
    assert.equal(DEFAULT_OPENAI_MODELS.includes(rec), true);
  });

  test('recommended model for anthropic is in the default list', () => {
    const rec = getRecommendedModel('anthropic');
    assert.equal(DEFAULT_ANTHROPIC_MODELS.includes(rec), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 14. AI Models — Invalid provider handling
// ═══════════════════════════════════════════════════════════════════════

describe('Model invalid provider handling', () => {
  test('detectProviderFromModel returns null for unrecognized prefix', () => {
    assert.equal(detectProviderFromModel('unknown-model-xyz'), null);
  });

  test('detectProviderFromModel returns null for empty string', () => {
    assert.equal(detectProviderFromModel(''), null);
  });

  test('isModelAllowed with empty allowlist returns false', () => {
    assert.equal(isModelAllowed('gpt-4o', []), false);
  });

  test('isModelAllowed is case-sensitive', () => {
    assert.equal(isModelAllowed('GPT-4O-MINI', DEFAULT_OPENAI_MODELS), false);
  });

  test('compatibility check for unknown model format returns true (allow-by-default)', () => {
    assert.equal(isModelCompatibleWithProvider('brand-new-model', 'openai'), true);
    assert.equal(isModelCompatibleWithProvider('brand-new-model', 'anthropic'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 15. Feedback — Submit feedback schema: rating (1-5), message, page
// ═══════════════════════════════════════════════════════════════════════

describe('Feedback submit schema edge cases', () => {
  test('accepts all valid ratings 1 through 5', () => {
    for (let r = 1; r <= 5; r++) {
      const result = validateFeedback({ rating: r, message: 'ok' });
      assert.equal(result.valid, true, `rating ${r} should be valid`);
    }
  });

  test('accepts feedback with page field', () => {
    const result = validateFeedback({ rating: 3, message: 'Nice', page: '/settings' });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.page, '/settings');
    }
  });

  test('accepts feedback without page (optional)', () => {
    const result = validateFeedback({ rating: 5, message: 'Love it' });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.page, undefined);
    }
  });

  test('accepts null page', () => {
    const result = validateFeedback({ rating: 3, message: 'ok', page: null });
    assert.equal(result.valid, true);
  });

  test('trims message whitespace', () => {
    const result = validateFeedback({ rating: 3, message: '  spaced  ' });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.message, 'spaced');
    }
  });

  test('truncates page to 500 chars', () => {
    const result = validateFeedback({ rating: 3, message: 'ok', page: '/p/' + 'x'.repeat(600) });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.page!.length, 500);
    }
  });

  test('accepts exactly 2000-char message', () => {
    const result = validateFeedback({ rating: 1, message: 'a'.repeat(2000) });
    assert.equal(result.valid, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 16. Feedback — Invalid rating rejected
// ═══════════════════════════════════════════════════════════════════════

describe('Feedback invalid rating rejected', () => {
  test('rejects rating 0', () => {
    const result = validateFeedback({ rating: 0, message: 'bad' });
    assert.equal(result.valid, false);
  });

  test('rejects rating 6', () => {
    const result = validateFeedback({ rating: 6, message: 'too much' });
    assert.equal(result.valid, false);
  });

  test('rejects negative rating', () => {
    const result = validateFeedback({ rating: -1, message: 'neg' });
    assert.equal(result.valid, false);
  });

  test('rejects non-integer rating 3.5', () => {
    const result = validateFeedback({ rating: 3.5, message: 'ok' });
    assert.equal(result.valid, false);
  });

  test('rejects string rating', () => {
    const result = validateFeedback({ rating: '5' as unknown as number, message: 'ok' });
    assert.equal(result.valid, false);
  });

  test('rejects missing rating', () => {
    const result = validateFeedback({ message: 'no rating' } as unknown);
    assert.equal(result.valid, false);
  });

  test('rejects NaN rating', () => {
    const result = validateFeedback({ rating: NaN, message: 'nan' });
    assert.equal(result.valid, false);
  });

  test('rejects Infinity rating', () => {
    const result = validateFeedback({ rating: Infinity, message: 'inf' });
    assert.equal(result.valid, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 17. Feedback — Empty message handling
// ═══════════════════════════════════════════════════════════════════════

describe('Feedback empty message handling', () => {
  test('rejects empty string message', () => {
    const result = validateFeedback({ rating: 3, message: '' });
    assert.equal(result.valid, false);
  });

  test('rejects whitespace-only message', () => {
    const result = validateFeedback({ rating: 3, message: '   ' });
    assert.equal(result.valid, false);
  });

  test('rejects tab-only message', () => {
    const result = validateFeedback({ rating: 3, message: '\t\t' });
    assert.equal(result.valid, false);
  });

  test('rejects newline-only message', () => {
    const result = validateFeedback({ rating: 3, message: '\n\n' });
    assert.equal(result.valid, false);
  });

  test('rejects message over 2000 chars', () => {
    const result = validateFeedback({ rating: 3, message: 'x'.repeat(2001) });
    assert.equal(result.valid, false);
  });

  test('rejects missing message field', () => {
    const result = validateFeedback({ rating: 3 } as unknown);
    assert.equal(result.valid, false);
  });

  test('rejects numeric message type', () => {
    const result = validateFeedback({ rating: 3, message: 42 as unknown as string });
    assert.equal(result.valid, false);
  });

  test('rejects null body entirely', () => {
    const result = validateFeedback(null);
    assert.equal(result.valid, false);
  });

  test('rejects undefined body', () => {
    const result = validateFeedback(undefined);
    assert.equal(result.valid, false);
  });

  test('rejects non-string page type', () => {
    const result = validateFeedback({ rating: 3, message: 'ok', page: 123 });
    assert.equal(result.valid, false);
  });
});
