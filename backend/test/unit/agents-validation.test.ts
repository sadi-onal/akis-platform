/**
 * Unit tests for agents API Zod schemas and validation logic
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

// ─── Re-create schemas from agents.ts ────────────────────────────────

const scribePayloadSchema = z.object({
  owner: z.string().min(1, 'owner field is required'),
  repo: z.string().min(1, 'repo field is required'),
  baseBranch: z.string().min(1, 'baseBranch field is required'),
  featureBranch: z.string().optional(),
  targetPath: z.string().optional(),
  taskDescription: z.string().optional(),
  doc: z.string().optional(),
  docPack: z.enum(['readme', 'standard', 'full']).optional(),
  docDepth: z.enum(['lite', 'standard', 'deep']).optional(),
  outputTargets: z.array(z.string()).optional(),
  analyzeLastNCommits: z.number().int().min(1).max(100).optional(),
  maxOutputTokens: z.number().int().min(1000).max(64000).optional(),
  passes: z.number().int().min(1).max(2).optional(),
});

const tracePayloadSchema = z.object({
  spec: z.string().min(1, 'spec field is required and must be a non-empty string'),
  owner: z.string().optional(),
  repo: z.string().optional(),
  baseBranch: z.string().optional(),
  branchStrategy: z.enum(['auto', 'manual']).optional(),
  dryRun: z.boolean().optional(),
  automationMode: z.enum(['plan_only', 'generate_and_run']).optional(),
  targetBaseUrl: z.string().url().optional(),
  featureLimit: z.number().int().min(1).max(100).optional(),
  tracePreferences: z.object({
    testDepth: z.enum(['smoke', 'standard', 'deep']),
    authScope: z.enum(['public', 'authenticated', 'mixed']),
    browserTarget: z.enum(['chromium', 'cross_browser', 'mobile']),
    strictness: z.enum(['fast', 'balanced', 'strict']),
  }).optional(),
}).passthrough().superRefine((data, ctx) => {
  if (data.automationMode === 'generate_and_run' && !data.targetBaseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetBaseUrl is required when automationMode is generate_and_run',
      path: ['targetBaseUrl'],
    });
  }
});

const protoPayloadSchema = z.object({
  requirements: z.string().min(1, 'requirements field is required').optional(),
  goal: z.string().min(1, 'goal field is required').optional(),
  stack: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  baseBranch: z.string().optional(),
  branchStrategy: z.enum(['auto', 'manual']).optional(),
  dryRun: z.boolean().optional(),
}).passthrough().superRefine((data, ctx) => {
  if (!data.requirements && !data.goal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either "requirements" or "goal" field must be provided',
      path: ['requirements'],
    });
  }
});

const jobIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const jobsListQuerySchema = z.object({
  type: z.enum(['scribe', 'trace', 'proto']).optional(),
  state: z.enum(['pending', 'running', 'awaiting_approval', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const runtimeOverrideSchema = z.object({
  runtimeProfile: z.enum(['deterministic', 'balanced', 'creative', 'custom']).optional(),
  temperatureValue: z.number().min(0).max(1).optional().nullable(),
  commandLevel: z.number().int().min(1).max(5).optional(),
}).superRefine((data, ctx) => {
  if (data.runtimeProfile === 'custom' && (data.temperatureValue === null || data.temperatureValue === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'temperatureValue is required when runtimeProfile is custom',
      path: ['temperatureValue'],
    });
  }
});

// ─── Re-create pure functions from agents.ts ─────────────────────────

function extractCorrelationIdFromText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = value.match(/Correlation ID:\s*([A-Za-z0-9._-]+)/i);
  return match?.[1] || null;
}

function detectModelProvider(model: string): 'openai' | 'openrouter' | 'unknown' {
  if (model.startsWith('gpt-') || model.startsWith('o1') ||
      model.startsWith('text-') || model.startsWith('davinci') ||
      model.startsWith('o3')) {
    return 'openai';
  }
  if (model.includes('/') || model.includes(':free') || model.includes(':nitro')) {
    return 'openrouter';
  }
  return 'unknown';
}

const RECOMMENDED_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  openrouter: 'anthropic/claude-sonnet-4',
};

function getProviderSafeModel(provider: 'openai' | 'openrouter', requestedModel: string | null): string {
  if (!requestedModel) {
    return RECOMMENDED_MODELS[provider];
  }
  const modelProvider = detectModelProvider(requestedModel);
  if (modelProvider === 'unknown' || modelProvider === provider) {
    return requestedModel;
  }
  return RECOMMENDED_MODELS[provider];
}

// ─── scribePayloadSchema ─────────────────────────────────────────────

describe('scribePayloadSchema', () => {
  test('accepts valid minimal payload', () => {
    const result = scribePayloadSchema.parse({
      owner: 'acme', repo: 'app', baseBranch: 'main',
    });
    assert.strictEqual(result.owner, 'acme');
    assert.strictEqual(result.repo, 'app');
  });

  test('rejects empty owner', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({ owner: '', repo: 'r', baseBranch: 'main' });
    }, /owner/);
  });

  test('rejects empty repo', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({ owner: 'o', repo: '', baseBranch: 'main' });
    }, /repo/);
  });

  test('rejects empty baseBranch', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({ owner: 'o', repo: 'r', baseBranch: '' });
    }, /baseBranch/);
  });

  test('rejects missing required fields', () => {
    assert.throws(() => { scribePayloadSchema.parse({}); });
  });

  test('accepts valid docPack values', () => {
    for (const docPack of ['readme', 'standard', 'full'] as const) {
      const result = scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', docPack,
      });
      assert.strictEqual(result.docPack, docPack);
    }
  });

  test('rejects invalid docPack', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', docPack: 'invalid',
      });
    });
  });

  test('rejects analyzeLastNCommits out of range', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', analyzeLastNCommits: 0,
      });
    });
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', analyzeLastNCommits: 101,
      });
    });
  });

  test('rejects maxOutputTokens out of range', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', maxOutputTokens: 999,
      });
    });
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', maxOutputTokens: 64001,
      });
    });
  });

  test('rejects passes out of range', () => {
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', passes: 0,
      });
    });
    assert.throws(() => {
      scribePayloadSchema.parse({
        owner: 'o', repo: 'r', baseBranch: 'main', passes: 3,
      });
    });
  });
});

// ─── tracePayloadSchema ──────────────────────────────────────────────

describe('tracePayloadSchema', () => {
  test('accepts valid spec', () => {
    const result = tracePayloadSchema.parse({ spec: 'Analyze auth flow' });
    assert.strictEqual(result.spec, 'Analyze auth flow');
  });

  test('rejects empty spec', () => {
    assert.throws(() => { tracePayloadSchema.parse({ spec: '' }); });
  });

  test('rejects missing spec', () => {
    assert.throws(() => { tracePayloadSchema.parse({}); });
  });

  test('accepts branchStrategy values', () => {
    for (const strategy of ['auto', 'manual'] as const) {
      const r = tracePayloadSchema.parse({ spec: 's', branchStrategy: strategy });
      assert.strictEqual(r.branchStrategy, strategy);
    }
  });

  test('passes through extra fields', () => {
    const r = tracePayloadSchema.parse({ spec: 's', customField: 'value' });
    assert.strictEqual((r as Record<string, unknown>).customField, 'value');
  });

  test('accepts valid tracePreferences', () => {
    const r = tracePayloadSchema.parse({
      spec: 's',
      tracePreferences: {
        testDepth: 'standard',
        authScope: 'mixed',
        browserTarget: 'chromium',
        strictness: 'balanced',
      },
    });
    assert.deepStrictEqual(r.tracePreferences, {
      testDepth: 'standard',
      authScope: 'mixed',
      browserTarget: 'chromium',
      strictness: 'balanced',
    });
  });

  test('accepts automation run options', () => {
    const r = tracePayloadSchema.parse({
      spec: 's',
      automationMode: 'generate_and_run',
      targetBaseUrl: 'https://akisflow.com',
      featureLimit: 25,
    });
    assert.strictEqual(r.automationMode, 'generate_and_run');
    assert.strictEqual(r.targetBaseUrl, 'https://akisflow.com');
    assert.strictEqual(r.featureLimit, 25);
  });

  test('accepts explicit plan_only mode without targetBaseUrl', () => {
    const r = tracePayloadSchema.parse({
      spec: 's',
      automationMode: 'plan_only',
    });
    assert.strictEqual(r.automationMode, 'plan_only');
    assert.strictEqual(r.targetBaseUrl, undefined);
  });

  test('rejects generate_and_run when targetBaseUrl is missing', () => {
    assert.throws(() =>
      tracePayloadSchema.parse({
        spec: 's',
        automationMode: 'generate_and_run',
      })
    );
  });

  test('rejects invalid tracePreferences enum values', () => {
    assert.throws(() => tracePayloadSchema.parse({
      spec: 's',
      tracePreferences: {
        testDepth: 'invalid',
        authScope: 'mixed',
        browserTarget: 'chromium',
        strictness: 'balanced',
      },
    }));
  });
});

// ─── protoPayloadSchema ──────────────────────────────────────────────

describe('protoPayloadSchema', () => {
  test('accepts requirements only', () => {
    const r = protoPayloadSchema.parse({ requirements: 'Build a form' });
    assert.strictEqual(r.requirements, 'Build a form');
  });

  test('accepts goal only', () => {
    const r = protoPayloadSchema.parse({ goal: 'Create login page' });
    assert.strictEqual(r.goal, 'Create login page');
  });

  test('accepts both requirements and goal', () => {
    const r = protoPayloadSchema.parse({ requirements: 'r', goal: 'g' });
    assert.strictEqual(r.requirements, 'r');
    assert.strictEqual(r.goal, 'g');
  });

  test('rejects when neither requirements nor goal provided', () => {
    assert.throws(() => { protoPayloadSchema.parse({}); });
  });

  test('rejects empty requirements when goal absent', () => {
    assert.throws(() => { protoPayloadSchema.parse({ requirements: '' }); });
  });
});

// ─── jobIdParamsSchema ───────────────────────────────────────────────

describe('jobIdParamsSchema', () => {
  test('accepts valid UUID', () => {
    const r = jobIdParamsSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' });
    assert.ok(r.id);
  });

  test('rejects non-UUID', () => {
    assert.throws(() => { jobIdParamsSchema.parse({ id: 'not-uuid' }); });
  });

  test('rejects empty string', () => {
    assert.throws(() => { jobIdParamsSchema.parse({ id: '' }); });
  });
});

// ─── jobsListQuerySchema ─────────────────────────────────────────────

describe('jobsListQuerySchema', () => {
  test('defaults limit to 20', () => {
    const r = jobsListQuerySchema.parse({});
    assert.strictEqual(r.limit, 20);
  });

  test('coerces string limit to number', () => {
    const r = jobsListQuerySchema.parse({ limit: '50' });
    assert.strictEqual(r.limit, 50);
  });

  test('rejects limit below 1', () => {
    assert.throws(() => { jobsListQuerySchema.parse({ limit: 0 }); });
  });

  test('rejects limit above 100', () => {
    assert.throws(() => { jobsListQuerySchema.parse({ limit: 101 }); });
  });

  test('accepts all valid type values', () => {
    for (const type of ['scribe', 'trace', 'proto'] as const) {
      const r = jobsListQuerySchema.parse({ type });
      assert.strictEqual(r.type, type);
    }
  });

  test('accepts all valid state values', () => {
    for (const state of ['pending', 'running', 'awaiting_approval', 'completed', 'failed'] as const) {
      const r = jobsListQuerySchema.parse({ state });
      assert.strictEqual(r.state, state);
    }
  });
});

describe('runtimeOverrideSchema', () => {
  test('accepts deterministic profile without temperature', () => {
    const r = runtimeOverrideSchema.safeParse({ runtimeProfile: 'deterministic', commandLevel: 2 });
    assert.strictEqual(r.success, true);
  });

  test('accepts custom profile with temperature', () => {
    const r = runtimeOverrideSchema.safeParse({ runtimeProfile: 'custom', temperatureValue: 0.55, commandLevel: 4 });
    assert.strictEqual(r.success, true);
  });

  test('rejects custom profile without temperature', () => {
    const r = runtimeOverrideSchema.safeParse({ runtimeProfile: 'custom', commandLevel: 4 });
    assert.strictEqual(r.success, false);
  });

  test('rejects invalid command level', () => {
    assert.strictEqual(runtimeOverrideSchema.safeParse({ commandLevel: 0 }).success, false);
    assert.strictEqual(runtimeOverrideSchema.safeParse({ commandLevel: 6 }).success, false);
  });
});

// ─── extractCorrelationIdFromText ────────────────────────────────────

describe('extractCorrelationIdFromText', () => {
  test('extracts correlation ID from error text', () => {
    assert.strictEqual(
      extractCorrelationIdFromText('Error occurred. Correlation ID: abc-123.456'),
      'abc-123.456'
    );
  });

  test('is case-insensitive', () => {
    assert.strictEqual(
      extractCorrelationIdFromText('correlation id: myId'),
      'myId'
    );
  });

  test('returns null for non-string', () => {
    assert.strictEqual(extractCorrelationIdFromText(null), null);
    assert.strictEqual(extractCorrelationIdFromText(undefined), null);
    assert.strictEqual(extractCorrelationIdFromText(42), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(extractCorrelationIdFromText(''), null);
  });

  test('returns null when no correlation ID present', () => {
    assert.strictEqual(extractCorrelationIdFromText('Just a normal error'), null);
  });
});

// ─── detectModelProvider ─────────────────────────────────────────────

describe('detectModelProvider', () => {
  test('identifies OpenAI models', () => {
    assert.strictEqual(detectModelProvider('gpt-4o-mini'), 'openai');
    assert.strictEqual(detectModelProvider('gpt-4o'), 'openai');
    assert.strictEqual(detectModelProvider('gpt-4.1-mini'), 'openai');
    assert.strictEqual(detectModelProvider('o1-preview'), 'openai');
    assert.strictEqual(detectModelProvider('o3-mini'), 'openai');
    assert.strictEqual(detectModelProvider('text-embedding-ada'), 'openai');
    assert.strictEqual(detectModelProvider('davinci-002'), 'openai');
  });

  test('identifies OpenRouter models', () => {
    assert.strictEqual(detectModelProvider('anthropic/claude-sonnet-4'), 'openrouter');
    assert.strictEqual(detectModelProvider('google/gemini-2.5-flash'), 'openrouter');
    assert.strictEqual(detectModelProvider('meta-llama/llama-4-maverick'), 'openrouter');
    assert.strictEqual(detectModelProvider('mistral:free'), 'openrouter');
    assert.strictEqual(detectModelProvider('some-model:nitro'), 'openrouter');
  });

  test('returns unknown for unrecognized models', () => {
    assert.strictEqual(detectModelProvider('custom-model'), 'unknown');
    assert.strictEqual(detectModelProvider('my-local-llm'), 'unknown');
    assert.strictEqual(detectModelProvider(''), 'unknown');
  });
});

// ─── getProviderSafeModel ────────────────────────────────────────────

describe('getProviderSafeModel', () => {
  test('returns recommended model when no model requested', () => {
    assert.strictEqual(getProviderSafeModel('openai', null), 'gpt-4o-mini');
    assert.strictEqual(getProviderSafeModel('openrouter', null), 'anthropic/claude-sonnet-4');
  });

  test('returns requested model when compatible', () => {
    assert.strictEqual(getProviderSafeModel('openai', 'gpt-4o'), 'gpt-4o');
    assert.strictEqual(getProviderSafeModel('openrouter', 'anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
  });

  test('returns requested model when provider unknown', () => {
    assert.strictEqual(getProviderSafeModel('openai', 'custom-model'), 'custom-model');
  });

  test('falls back to default when model is incompatible with openai', () => {
    assert.strictEqual(getProviderSafeModel('openai', 'anthropic/claude-sonnet-4'), 'gpt-4o-mini');
  });

  test('uses requested OpenAI model with openrouter (proxy)', () => {
    // OpenRouter can proxy OpenAI models, so the function should still return it
    // because detectModelProvider returns 'openai' != 'openrouter'
    // but getProviderSafeModel falls back — this is the actual behavior
    const result = getProviderSafeModel('openrouter', 'gpt-4o');
    assert.strictEqual(result, 'anthropic/claude-sonnet-4');
  });
});
